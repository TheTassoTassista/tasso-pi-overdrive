// Trusted durable publication journal, never a model endpoint. V1 metadata
// only; V2 single-file MODIFY uses the internal native transaction primitive.
// V3 single DELETE uses handle-anchored quarantine, not TxF or bare unlink.
// V4 explicit same-directory RENAME uses the expected-source native primitive.
// Append-only flushed envelopes; uncertain/restarted state is never PUBLISHED.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Phi.Native {
  internal sealed class PublicationJournal : IDisposable {
    internal const string RegistryBase = "Software\\Phi\\PublicationJournalV1";
    const int MaxTransactions = 64, MaxEvents = 512, MaxBytes = 65536;
    internal static readonly string[] Phases = { "PREPARED", "TEMP_CREATED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "DELETE_INTENT", "DELETE_QUARANTINED", "RENAME_INTENT", "RENAMED", "COMMITTED", "VERIFIED", "POST_COMMIT_VERIFIED", "CLEANUP_STARTED", "CLEANED", "CONFLICT", "ROLLBACK_REQUIRED", "ROLLED_BACK", "RECOVERY_REQUIRED", "FAILED" };
    static readonly Regex Id = new Regex("\\A[0-9a-f]{32}\\z", RegexOptions.CultureInvariant);
    static readonly Regex Identity = new Regex("\\A[0-9a-f]{16}:[0-9a-f]{32}\\z", RegexOptions.CultureInvariant);
    static readonly Regex Digest = new Regex("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);
    [DllImport("advapi32.dll")] static extern int RegFlushKey(IntPtr key);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegQueryValueExW(IntPtr key, string name, IntPtr reserved, out uint type, byte[] bytes, ref uint size);
    readonly string id, project;
    readonly Mutex lease;
    readonly RecoveryFilesystem pins;
    Dictionary<string, object> header, last;
    string lastDigest;
    bool acquired, poisoned, disposed, deleteCleanupIntent;
    sealed class AdmissionConflict : InvalidOperationException {
      internal readonly object Evidence;
      internal AdmissionConflict(Dictionary<string, object> value) : base("PHI_PUBLICATION_CONFLICT") {
        // Validated immutable request + a completed anchored snapshot with the
        // expected root ID. This is rejection evidence, NOT a durable journal.
        Evidence = new { version = 1, scope = "VALIDATED_BASE_CONFLICT_BEFORE_JOURNAL", phase = "ADMISSION_CONFLICT",
          transactionId = value["transactionId"], projectIdentity = value["projectIdentity"], draftId = value["draftId"], draftVersion = value["draftVersion"],
          verifiedDigest = value["verifiedDigest"], baseDigest = value["baseDigest"], operations = value["operations"], journalCreated = false,
          mutationStarted = false, filesCommitted = new string[0], pendingOperations = 1, commitState = "NOT_STARTED",
          recoveryState = "NOT_STARTED", cleanup = "NOT_STARTED", projectPublished = false };
      }
    }
    static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = MaxBytes, RecursionLimit = 16 }; }
    static string Hash(byte[] bytes) { using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static void Keys(Dictionary<string, object> value, params string[] keys) {
      if (value == null || value.Count != keys.Length || keys.Any(k => !value.ContainsKey(k))) throw new InvalidDataException();
    }
    static string StringField(Dictionary<string, object> value, string key, Regex pattern) {
      string text = value[key] as string; if (text == null || !pattern.IsMatch(text)) throw new InvalidDataException(); return text;
    }
    static int Number(Dictionary<string, object> value, string key, int min, int max) {
      if (!(value[key] is int) || (int)value[key] < min || (int)value[key] > max) throw new InvalidDataException(); return (int)value[key];
    }
    static RegistryKey OpenBase(bool create) {
      RegistryKey key = Registry.CurrentUser.OpenSubKey(RegistryBase, create);
      if (key == null && create) key = Registry.CurrentUser.CreateSubKey(RegistryBase, RegistryKeyPermissionCheck.ReadWriteSubTree, RegistryOptions.None, ScopeRecovery.PrivateRegistryAcl());
      if (key == null) throw new InvalidDataException();
      try { ScopeRecovery.ValidateRegistry(key); return key; } catch { key.Dispose(); throw; }
    }
    static Mutex Lease(string transactionId, bool admission = false) {
      if (!Id.IsMatch(transactionId)) throw new InvalidDataException();
      SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
      MutexSecurity acl = new MutexSecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(user);
      foreach (SecurityIdentifier sid in new SecurityIdentifier[] { user, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) }) acl.AddAccessRule(new MutexAccessRule(sid, MutexRights.FullControl, AccessControlType.Allow));
      bool created; Mutex result = new Mutex(false, "Local\\Phi.Publication." + user.Value + "." + (admission ? "Admission" : transactionId), out created, acl);
      try {
        MutexSecurity actual = result.GetAccessControl();
        if (!actual.AreAccessRulesProtected || !user.Equals(actual.GetOwner(typeof(SecurityIdentifier)))) throw new InvalidDataException();
        foreach (MutexAccessRule rule in actual.GetAccessRules(true, true, typeof(SecurityIdentifier)))
          if (rule.AccessControlType != AccessControlType.Allow || (rule.IdentityReference.Value != user.Value && rule.IdentityReference.Value != "S-1-5-18")) throw new InvalidDataException();
        return result;
      } catch { result.Dispose(); throw; }
    }
    static bool Acquire(Mutex mutex, int waitMs = 0) { try { return mutex.WaitOne(waitMs); } catch (AbandonedMutexException) { return true; } }
    static byte[] Envelope(Dictionary<string, object> body) {
      byte[] bytes = new UTF8Encoding(false, true).GetBytes(Serializer().Serialize(body));
      if (bytes.Length > MaxBytes - 40) throw new InvalidDataException();
      byte[] result = new byte[bytes.Length + 40];
      Buffer.BlockCopy(BitConverter.GetBytes(1), 0, result, 0, 4); Buffer.BlockCopy(BitConverter.GetBytes(bytes.Length), 0, result, 4, 4);
      Buffer.BlockCopy(bytes, 0, result, 8, bytes.Length);
      using (SHA256 hash = SHA256.Create()) Buffer.BlockCopy(hash.ComputeHash(bytes), 0, result, bytes.Length + 8, 32);
      return result;
    }
    static Dictionary<string, object> Decode(byte[] bytes) {
      if (bytes.Length < 42 || bytes.Length > MaxBytes || BitConverter.ToInt32(bytes, 0) != 1 || BitConverter.ToInt32(bytes, 4) != bytes.Length - 40) throw new InvalidDataException();
      byte[] body = new byte[bytes.Length - 40]; Buffer.BlockCopy(bytes, 8, body, 0, body.Length);
      using (SHA256 hash = SHA256.Create()) if (!hash.ComputeHash(body).SequenceEqual(bytes.Skip(bytes.Length - 32))) throw new InvalidDataException();
      return Serializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(body));
    }
    static byte[] ReadValue(RegistryKey key, string name) {
      ScopeRecovery.ValidateRegistry(key); uint type, size = 0;
      if (RegQueryValueExW(key.Handle.DangerousGetHandle(), name, IntPtr.Zero, out type, null, ref size) != 0 || type != 3 || size < 42 || size > MaxBytes) throw new InvalidDataException();
      byte[] bytes = new byte[size]; uint actual = size;
      if (RegQueryValueExW(key.Handle.DangerousGetHandle(), name, IntPtr.Zero, out type, bytes, ref actual) != 0 || type != 3 || actual != size) throw new InvalidDataException(); return bytes;
    }
    static IList Operations(Dictionary<string, object> value) {
      IList operations = value["operations"] as IList; if (operations == null || operations.Count < 1 || operations.Count > 64) throw new InvalidDataException(); return operations;
    }
    static void ValidateHeader(Dictionary<string, object> value, string transactionId) {
      Keys(value, "version", "transactionId", "projectIdentity", "draftId", "draftVersion", "verifiedDigest", "baseDigest", "creatorPid", "creatorGeneration", "operations");
      int version = Number(value, "version", 1, 4); if (StringField(value, "transactionId", Id) != transactionId) throw new InvalidDataException();
      StringField(value, "projectIdentity", Identity); StringField(value, "draftId", Id); Number(value, "draftVersion", 0, Int32.MaxValue);
      StringField(value, "verifiedDigest", Digest); StringField(value, "baseDigest", Digest); Number(value, "creatorPid", 1, Int32.MaxValue);
      StringField(value, "creatorGeneration", new Regex("\\A[0-9a-f]{16}\\z"));
      HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase), ids = new HashSet<string>(StringComparer.Ordinal);
      foreach (object entry in Operations(value)) {
        Dictionary<string, object> op = entry as Dictionary<string, object>;
        if (version == 4) Keys(op, "sourcePath", "path", "kind", "baseIdentity", "baseDigest", "newDigest", "newBytes");
        else Keys(op, "path", "kind", "baseIdentity", "baseDigest", "newDigest", "newBytes");
        string relative = op["path"] as string; AnchoredFile.Segments(relative);
        if (relative.Length > 240 || !Regex.IsMatch(relative, "\\A[A-Za-z0-9_./-]+\\z") || !names.Add(relative)) throw new InvalidDataException();
        string kind = op["kind"] as string; if (kind != "CREATE" && kind != "REPLACE" && kind != "DELETE" && kind != "RENAME") throw new InvalidDataException();
        if (kind == "RENAME" && version != 4) throw new InvalidDataException();
        if (kind == "CREATE") { if (op["baseIdentity"] != null || op["baseDigest"] != null) throw new InvalidDataException(); }
        else { if (!ids.Add(StringField(op, "baseIdentity", Identity))) throw new InvalidDataException(); StringField(op, "baseDigest", Digest); }
        if (kind == "DELETE") { if (op["newDigest"] != null || op["newBytes"] != null) throw new InvalidDataException(); }
        else { StringField(op, "newDigest", Digest); Number(op, "newBytes", 0, 1024 * 1024); }
        if (version == 2 && (Operations(value).Count != 1 || kind != "REPLACE" || Object.Equals(op["baseDigest"], op["newDigest"]))) throw new InvalidDataException();
        if (version == 3 && (Operations(value).Count != 1 || kind != "DELETE" || relative.Split('/').Last() == DeleteLeaf(transactionId))) throw new InvalidDataException();
        if (version == 4) {
          string source = op["sourcePath"] as string; string[] sourceParts = AnchoredFile.Segments(source), targetParts = AnchoredFile.Segments(relative);
          if (Operations(value).Count != 1 || kind != "RENAME" || source.Length > 240 ||
              !Regex.IsMatch(source, "\\A[A-Za-z0-9_./-]+\\z") || sourceParts.Length != targetParts.Length ||
              !sourceParts.Take(sourceParts.Length - 1).SequenceEqual(targetParts.Take(targetParts.Length - 1), StringComparer.OrdinalIgnoreCase) ||
              String.Equals(source, relative, StringComparison.OrdinalIgnoreCase) || !Object.Equals(op["baseDigest"], op["newDigest"])) throw new InvalidDataException();
        }
      }
    }
    static bool Transition(string from, string to, int previousOp, int nextOp, int count, int version) {
      if (!Phases.Contains(to) || from == "CLEANED" || from == "ROLLED_BACK" || from == "FAILED" || from == "CONFLICT") return false;
      if (to == "CONFLICT" || to == "FAILED" || to == "RECOVERY_REQUIRED" || to == "ROLLBACK_REQUIRED") return previousOp == nextOp;
      if (from == "ROLLBACK_REQUIRED") return to == "ROLLED_BACK" && previousOp == nextOp;
      if (from == "RECOVERY_REQUIRED") return false; // needs a separately proven recovery adapter, not a guessed phase
      if (from == "VERIFIED" && to == "TEMP_WRITTEN") return nextOp == previousOp + 1 && nextOp < count;
      if (previousOp != nextOp) return false;
      string[] normal = version == 4 ? new string[] { "PREPARED", "RENAME_INTENT", "RENAMED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }
        : version == 3 ? new string[] { "PREPARED", "DELETE_INTENT", "DELETE_QUARANTINED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANUP_STARTED", "CLEANED" }
        : version == 2 ? new string[] { "PREPARED", "TEMP_CREATED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }
        : new string[] { "PREPARED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "COMMITTED", "VERIFIED", "CLEANED" };
      int index = Array.IndexOf(normal, from);
      return index >= 0 && index < normal.Length - 1 && normal[index + 1] == to && (to != "CLEANED" || nextOp == count - 1);
    }
    static Dictionary<string, object> Snapshot(string project, string expected) {
      using (RecoveryFilesystem pins = new RecoveryFilesystem(project)) {
        // Extraction has its existing independent file/content bounds. It is
        // never stored in the metadata journal or emitted as a receipt.
        JavaScriptSerializer extraction = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 16 };
        Dictionary<string, object> snapshot = extraction.Deserialize<Dictionary<string, object>>(extraction.Serialize(pins.ReadProjectSnapshot()));
        if ((string)snapshot["rootIdentity"] != expected) throw new InvalidDataException(); return snapshot;
      }
    }
    static bool MatchesBase(string project, Dictionary<string, object> value) {
      Dictionary<string, object> snapshot = Snapshot(project, (string)value["projectIdentity"]);
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"], identities = (Dictionary<string, object>)snapshot["identities"];
      foreach (Dictionary<string, object> op in Operations(value)) {
        string name = (string)op["path"];
        if ((string)op["kind"] == "RENAME") {
          string source = (string)op["sourcePath"];
          if (files.ContainsKey(name) || !files.ContainsKey(source) ||
              (string)identities[source] != (string)op["baseIdentity"] ||
              Hash(Encoding.UTF8.GetBytes((string)files[source])) != (string)op["baseDigest"] ||
              Encoding.UTF8.GetByteCount((string)files[source]) != (int)op["newBytes"]) return false;
        }
        else if ((string)op["kind"] == "CREATE") { if (files.ContainsKey(name)) return false; }
        else if (!files.ContainsKey(name) || (string)identities[name] != (string)op["baseIdentity"] || Hash(Encoding.UTF8.GetBytes((string)files[name])) != (string)op["baseDigest"]) return false;
      }
      return true;
    }
    PublicationJournal(string transactionId, string projectRoot) {
      if (!Id.IsMatch(transactionId)) throw new InvalidDataException(); id = transactionId; project = projectRoot;
      lease = Lease(id);
      try { acquired = Acquire(lease); if (!acquired) throw new InvalidDataException(); pins = new RecoveryFilesystem(project); }
      catch { Dispose(); throw; }
    }
    internal static PublicationJournal Begin(string project, Dictionary<string, object> metadata) {
      // Freeze through a serialization copy; callers cannot mutate the header.
      Dictionary<string, object> value = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(metadata));
      string transactionId = value["transactionId"] as string; ValidateHeader(value, transactionId);
      bool alive; int pid = Process.GetCurrentProcess().Id;
      if ((int)value["creatorPid"] != pid || ScopeRecovery.ProcessCreation(pid, out alive) != (string)value["creatorGeneration"] || !alive) throw new InvalidDataException();
      PublicationJournal result = new PublicationJournal(transactionId, project);
      try {
        if (!MatchesBase(project, value)) {
          // Keep V1 semantics and unknown/root/schema/sharing exceptions intact.
          // Only known V2 destination absence/identity/content mismatch reaches
          // this branch. No journal key or native transaction exists yet.
          if ((int)value["version"] >= 2) throw new AdmissionConflict(value);
          throw new InvalidDataException();
        }
        using (Mutex admission = Lease(transactionId, true)) {
          if (!Acquire(admission, 1000)) throw new InvalidDataException();
          try { using (RegistryKey root = OpenBase(true)) {
          if (root.GetSubKeyNames().Length >= MaxTransactions) throw new InvalidDataException();
          using (RegistryKey existing = root.OpenSubKey(transactionId)) if (existing != null) throw new InvalidDataException();
          using (RegistryKey key = root.CreateSubKey(transactionId, RegistryKeyPermissionCheck.ReadWriteSubTree, RegistryOptions.None, ScopeRecovery.PrivateRegistryAcl())) {
            result.header = value; result.Append(key, "PREPARED", 0, null, null);
          }
          } } finally { admission.ReleaseMutex(); }
        }
        return result;
      } catch { result.Dispose(); throw; } // incomplete/unknown key retained, never guessed away
    }
    void Append(RegistryKey key, string phase, int operationIndex, string tempIdentity, string committedIdentity, bool nativeObservation = false) {
      if (poisoned || disposed || !acquired) throw new InvalidDataException();
      int sequence = last == null ? 0 : (int)last["sequence"] + 1;
      if (sequence >= MaxEvents || !Phases.Contains(phase) || operationIndex < 0 || operationIndex >= Operations(header).Count ||
          (tempIdentity != null && !Identity.IsMatch(tempIdentity)) || (committedIdentity != null && !Identity.IsMatch(committedIdentity))) throw new InvalidDataException();
      if (last != null && !Transition((string)last["phase"], phase, (int)last["operationIndex"], operationIndex, Operations(header).Count, (int)header["version"])) throw new InvalidDataException();
      if (last != null && last["tempIdentity"] != null && (int)last["operationIndex"] == operationIndex && !Object.Equals(last["tempIdentity"], tempIdentity)) throw new InvalidDataException();
      if (((int)header["version"] >= 2 && phase != "PREPARED" && !nativeObservation) ||
          ((int)header["version"] == 1 && new string[] { "COMMITTED", "VERIFIED", "POST_COMMIT_VERIFIED", "CLEANED" }.Contains(phase))) throw new InvalidOperationException("PHI_PUBLICATION_COMMIT_PROOF_NOT_IMPLEMENTED");
      // V1 remains precommit-only. V2 phases can only be written from this
      // class's actual native mutation/inspection observations, never Advance.
      Dictionary<string, object> body = new Dictionary<string, object> {
        { "sequence", sequence }, { "previousDigest", lastDigest ?? new string('0', 64) }, { "phase", phase }, { "operationIndex", operationIndex },
        { "tempIdentity", tempIdentity }, { "committedIdentity", committedIdentity }, { "header", sequence == 0 ? header : null }
      };
      string name = "E" + sequence.ToString("D8");
      if (key.GetValueNames().Contains(name)) throw new InvalidDataException();
      byte[] bytes = Envelope(body);
      try {
        ScopeRecovery.ValidateRegistry(key); key.SetValue(name, bytes, RegistryValueKind.Binary);
        if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0 || !ReadValue(key, name).SequenceEqual(bytes)) throw new InvalidDataException();
        // Flush both the transaction and its parent key before claiming PREPARED.
        if (sequence == 0) using (RegistryKey root = OpenBase(true)) if (RegFlushKey(root.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
      } catch { poisoned = true; throw; }
      last = body; lastDigest = Hash(bytes);
      if ((int)header["version"] == 3 && phase == "CLEANUP_STARTED") deleteCleanupIntent = true;
    }
    internal void Advance(string phase, string tempIdentity) {
      if ((int)header["version"] >= 2) throw new InvalidOperationException("PHI_PUBLICATION_NATIVE_OBSERVATION_REQUIRED");
      using (RegistryKey root = OpenBase(true)) using (RegistryKey key = root.OpenSubKey(id, true)) {
        if (key == null) throw new InvalidDataException();
        ReadChain(key); // detect unexpected append/corruption before another write
        if ((phase == "READY_TO_COMMIT" || phase == "COMMIT_STARTED") && !MatchesBase(project, header)) {
          Append(key, "CONFLICT", (int)last["operationIndex"], last["tempIdentity"] as string, null);
          throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
        }
        Append(key, phase, (int)last["operationIndex"], tempIdentity, null);
      }
    }
    void Observe(string phase, string tempIdentity, string committedIdentity) {
      if ((int)header["version"] < 2) throw new InvalidDataException();
      using (RegistryKey root = OpenBase(true)) using (RegistryKey key = root.OpenSubKey(id, true)) {
        if (key == null) throw new InvalidDataException(); ReadChain(key);
        // READY is recorded only after the actual temp flush/hash. The actual
        // native writer subsequently re-checks the target under its KTM lock.
        if (phase == "READY_TO_COMMIT" && !MatchesBase(project, header)) {
          Append(key, "CONFLICT", 0, tempIdentity, null, true); throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
        }
        Append(key, phase, 0, tempIdentity, committedIdentity, true);
      }
    }
    internal object PublishSingleModify(byte[] bytes, Action<string> checkpoint) {
      if ((int)header["version"] != 2 || (string)last["phase"] != "PREPARED") throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      if (bytes == null || bytes.Length != (int)op["newBytes"] || Hash(bytes) != (string)op["newDigest"]) throw new InvalidDataException();
      object proof;
      try { proof = AtomicModify.ReplaceDefaultStream(project, (string)header["projectIdentity"], (string)op["path"], (string)op["baseIdentity"], (string)op["baseDigest"], bytes, delegate(string phase, string temp) {
        if (phase == "temp") Observe("TEMP_CREATED", temp, null);
        else if (phase == "write") Observe("TEMP_WRITTEN", temp, null);
        else if (phase == "flush") Observe("TEMP_FLUSHED", temp, null);
        else if (phase == "validation") Observe("READY_TO_COMMIT", temp, null);
        else if (phase == "locked") Observe("COMMIT_STARTED", temp, null);
        else if (phase == "committed") {
          // A real kill here leaves a durable COMMIT_STARTED prefix and NEW
          // complete bytes. Recovery must inspect the file, not guess OLD.
          checkpoint("before-journal-committed");
          Observe("COMMITTED", temp, (string)op["baseIdentity"]);
        }
        else if (phase == "postverify") Observe("POST_COMMIT_VERIFIED", temp, (string)op["baseIdentity"]);
        else if (phase == "cleanup") Observe("CLEANED", temp, (string)op["baseIdentity"]);
        checkpoint(phase);
      }); } catch (InvalidOperationException error) {
        if (error.Message != "PHI_ATOMIC_MODIFY_CONFLICT" && error.Message != "PHI_PUBLICATION_CONFLICT") throw;
        if ((string)last["phase"] != "CONFLICT") Observe("CONFLICT", last["tempIdentity"] as string, null);
        throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
      }
      if ((string)last["phase"] != "CLEANED") throw new InvalidDataException();
      return new { journal = Metadata("NOT_REQUIRED"), nativeProof = proof };
    }
    object InspectSingleModify(bool recover) {
      if ((int)header["version"] != 2) throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string[] parts = AnchoredFile.Segments((string)op["path"]);
      string destination = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(destination))) {
        RecoveryFilesystem.Info info; IntPtr file;
        try { file = parent.OpenPublicationReadFile(parts[parts.Length - 1], out info); }
        catch (System.ComponentModel.Win32Exception error) {
          if (error.NativeErrorCode != 2) throw;
          return new { status = "CONFLICT", metadata = Metadata("CONFLICT"), observedIdentity = (string)null, observedDigest = (string)null,
            ownerGenerationAlive = false, baseMatches = false, newMatches = false, journalMutations = 0, projectMutations = 0, processKills = 0,
            projectPublished = false, destinationMissing = true, recoveryScope = "SINGLE_FILE_CONTENT_OBSERVATION_NOT_CONTROLLER_VERIFICATION" };
        }
        try {
          if ((info.Attributes & (0x10 | 0x400)) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 1024 * 1024) throw new InvalidDataException();
          byte[] bytes;
          using (FileStream input = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(file, false), FileAccess.Read))
          using (MemoryStream data = new MemoryStream()) {
            byte[] block = new byte[4096]; int count;
            while ((count = input.Read(block, 0, block.Length)) != 0) { if (data.Length + count > 1024 * 1024) throw new InvalidDataException(); data.Write(block, 0, count); }
            bytes = data.ToArray();
          }
          string actualId = RecoveryFilesystem.HandleIdentity(file), actualDigest = Hash(bytes), phase = (string)last["phase"];
          bool old = actualId == (string)op["baseIdentity"] && actualDigest == (string)op["baseDigest"];
          bool next = actualId == (string)op["baseIdentity"] && actualDigest == (string)op["newDigest"] && bytes.Length == (int)op["newBytes"];
          bool commitRecorded = last["committedIdentity"] != null || new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }.Contains(phase);
          bool commitPossible = commitRecorded || phase == "COMMIT_STARTED" || phase == "RECOVERY_REQUIRED";
          string status = old && !commitRecorded ? "OLD_COMPLETE_OBSERVED" : next && commitPossible ? "NEW_COMPLETE_OBSERVED" : "CONFLICT";
          int previousSequence = (int)last["sequence"];
          if (recover && status == "OLD_COMPLETE_OBSERVED" && phase != "ROLLED_BACK") {
            Observe("ROLLBACK_REQUIRED", last["tempIdentity"] as string, null);
            Observe("ROLLED_BACK", last["tempIdentity"] as string, null);
          } else if (recover && status == "NEW_COMPLETE_OBSERVED" && phase != "CLEANED" && phase != "RECOVERY_REQUIRED") {
            if (phase == "COMMIT_STARTED") Observe("COMMITTED", last["tempIdentity"] as string, actualId);
            // Content/ID observation cannot restore the original live publisher's
            // ACL/creation-time proof or the controller's verified draft. Keep
            // RECOVERY_REQUIRED, never mint PUBLISHED/CLEANED on restart alone.
            Observe("RECOVERY_REQUIRED", last["tempIdentity"] as string, actualId);
          }
          return new { status, metadata = Metadata(status), observedIdentity = actualId, observedDigest = actualDigest,
            ownerGenerationAlive = false, baseMatches = old, newMatches = next, journalMutations = (int)last["sequence"] - previousSequence,
            projectMutations = 0, processKills = 0, projectPublished = false, recoveryScope = "SINGLE_FILE_CONTENT_OBSERVATION_NOT_CONTROLLER_VERIFICATION" };
        } finally { CloseNative(file); }
      }
    }
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void CloseNative(IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); }
    internal static int RunSingleModify(Stream input) {
      PublicationJournal journal = null; object result = null; string phase = "REQUEST";
      try {
        byte[] bytes;
        using (MemoryStream line = new MemoryStream()) {
          bool complete = false;
          for (int i = 0; i < 1024 * 1024; i++) { int next = input.ReadByte(); if (next < 0) throw new InvalidDataException(); if (next == 10) { complete = true; break; } line.WriteByte((byte)next); }
          if (!complete) throw new InvalidDataException(); bytes = line.ToArray();
        }
        JavaScriptSerializer reader = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 16 };
        Dictionary<string, object> request = reader.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(bytes));
        Keys(request, "version", "root", "header", "content", "guardianPid", "timeoutMs"); Number(request, "version", 1, 1);
        string project = request["root"] as string, content = request["content"] as string;
        if (project == null || project.Length > 1024 || project.IndexOf('\0') >= 0 || !Path.IsPathRooted(project) || content == null || content.IndexOf('\0') >= 0) throw new InvalidDataException();
        byte[] value = new UTF8Encoding(false, true).GetBytes(content);
        Dictionary<string, object> header = request["header"] as Dictionary<string, object>;
        Keys(header, "transactionId", "projectIdentity", "draftId", "draftVersion", "verifiedDigest", "baseDigest", "operations");
        bool alive; int pid = Process.GetCurrentProcess().Id;
        header.Add("version", 2); header.Add("creatorPid", pid); header.Add("creatorGeneration", ScopeRecovery.ProcessCreation(pid, out alive));
        if (!alive) throw new InvalidDataException(); ValidateHeader(header, header["transactionId"] as string);
        Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
        if (value.Length != (int)op["newBytes"] || Hash(value) != (string)op["newDigest"]) throw new InvalidDataException();
        OwnedProcess.WithPublicationGuardian(Number(request, "guardianPid", 1, Int32.MaxValue), Number(request, "timeoutMs", 1, 30000), delegate(Action live) {
          phase = "ADMISSION"; journal = Begin(project, header); phase = "PREPARED";
          result = journal.PublishSingleModify(value, delegate(string observed) { phase = observed; live(); });
        });
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_NATIVE_SINGLE_MODIFY", receipt = result, projectPublished = false, externalRequests = 0 })); return 0;
      } catch (Exception error) {
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_NATIVE_SINGLE_MODIFY", phase,
          reason = error is AdmissionConflict || error is InvalidOperationException && error.Message == "PHI_PUBLICATION_CONFLICT" ? "CONFLICT" : "UNCONFIRMED",
          nativeCode = unchecked((uint)Marshal.GetHRForException(error)).ToString("x8"),
          journal = journal == null ? null : journal.Metadata("INSPECTION_REQUIRED"), admission = error is AdmissionConflict ? ((AdmissionConflict)error).Evidence : null,
          projectPublished = false, externalRequests = 0 })); return 70;
      } finally { if (journal != null) journal.Dispose(); }
    }
    static string DeleteLeaf(string transactionId) {
      if (!Id.IsMatch(transactionId)) throw new InvalidDataException();
      return "phi-delete-" + transactionId + ".quarantine";
    }
    sealed class DeleteObject {
      internal string Identity, Digest;
      internal long Bytes;
    }
    static DeleteObject ReadDeleteObject(IntPtr file) {
      using (FileStream input = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(file, false), FileAccess.Read))
      using (MemoryStream data = new MemoryStream()) {
        input.Position = 0; byte[] block = new byte[4096]; int count;
        while ((count = input.Read(block, 0, block.Length)) != 0) { if (data.Length + count > 1024 * 1024) throw new InvalidDataException(); data.Write(block, 0, count); }
        return new DeleteObject { Identity = RecoveryFilesystem.HandleIdentity(file), Digest = Hash(data.ToArray()), Bytes = data.Length };
      }
    }
    static DeleteObject ReadDeleteLeaf(RecoveryFilesystem parent, string leaf) {
      IntPtr file = IntPtr.Zero;
      try {
        RecoveryFilesystem.Info info; file = parent.OpenPublicationReadFile(leaf, out info);
        if ((info.Attributes & (0x10 | 0x400)) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 1024 * 1024) throw new InvalidDataException();
        return ReadDeleteObject(file);
      } catch (System.ComponentModel.Win32Exception error) {
        if (error.NativeErrorCode != 2) throw; return null; // Only proved leaf absence.
      } finally { CloseNative(file); }
    }
    static bool DeleteBaseMatches(DeleteObject value, Dictionary<string, object> op) {
      return value != null && value.Identity == (string)op["baseIdentity"] && value.Digest == (string)op["baseDigest"];
    }
    internal object PublishSingleDelete(Action<string> checkpoint) {
      if ((int)header["version"] != 3 || (string)last["phase"] != "PREPARED") throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string[] parts = AnchoredFile.Segments((string)op["path"]);
      string destination = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
      string quarantine = DeleteLeaf(id), expected = (string)op["baseIdentity"];
      IntPtr source = IntPtr.Zero;
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(destination))) {
        try {
          checkpoint("before-delete"); RecoveryFilesystem.Info info;
          try { source = parent.OpenDeleteSource(parts.Last(), out info); }
          catch (System.ComponentModel.Win32Exception error) { if (error.NativeErrorCode != 2) throw; throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT"); }
          if (!DeleteBaseMatches(ReadDeleteObject(source), op)) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          // The expected object is exclusively held while durable intent is
          // flushed and immediately before the native no-replace rename.
          Observe("DELETE_INTENT", expected, null); checkpoint("intent");
          if (!DeleteBaseMatches(ReadDeleteObject(source), op)) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          parent.QuarantineDeleteSource(source, quarantine); checkpoint("renamed");
          Observe("DELETE_QUARANTINED", expected, null); checkpoint("quarantined");
          if (ReadDeleteLeaf(parent, parts.Last()) != null || !DeleteBaseMatches(ReadDeleteObject(source), op)) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          Observe("COMMITTED", expected, expected); checkpoint("committed");
          if (ReadDeleteLeaf(parent, parts.Last()) != null || !DeleteBaseMatches(ReadDeleteObject(source), op)) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          Observe("POST_COMMIT_VERIFIED", expected, expected); checkpoint("verified");
          // Irreversible cleanup happens only after a flushed, bound commit
          // and cleanup intent. It unlinks this SAME handle, never a pathname.
          Observe("CLEANUP_STARTED", expected, expected); checkpoint("cleanup-started");
          if (ReadDeleteLeaf(parent, parts.Last()) != null || !DeleteBaseMatches(ReadDeleteObject(source), op)) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          parent.UnlinkQuarantinedFile(source, expected); CloseNative(source); source = IntPtr.Zero; checkpoint("unlinked");
          if (ReadDeleteLeaf(parent, quarantine) != null || ReadDeleteLeaf(parent, parts.Last()) != null) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          Observe("CLEANED", expected, expected); checkpoint("cleaned");
          return new { journal = Metadata("NOT_REQUIRED"), nativeProof = new { backend = "HANDLE_ANCHORED_QUARANTINE_DELETE", sourceIdentity = expected,
            oldDigest = op["baseDigest"], quarantineIdentity = expected, sameDirectory = true, noClobber = true, committed = true,
            destinationAbsent = true, quarantineAbsent = true, txfUsed = false } };
        } catch (InvalidOperationException error) {
          if (error.Message != "PHI_PUBLICATION_CONFLICT") throw;
          if ((string)last["phase"] != "CONFLICT") Observe("CONFLICT", last["tempIdentity"] as string, last["committedIdentity"] as string);
          throw;
        } finally { CloseNative(source); }
      }
    }
    object InspectSingleDelete(bool recover) {
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string[] parts = AnchoredFile.Segments((string)op["path"]);
      string destination = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(destination))) {
        DeleteObject current = ReadDeleteLeaf(parent, parts.Last()), quarantined = ReadDeleteLeaf(parent, DeleteLeaf(id));
        string phase = (string)last["phase"], status = "UNKNOWN_FAIL_SAFE";
        bool original = DeleteBaseMatches(current, op), ownedQuarantine = DeleteBaseMatches(quarantined, op), committed = last["committedIdentity"] != null;
        if (phase == "CONFLICT" || current != null && !original || quarantined != null && !ownedQuarantine || current != null && quarantined != null) status = "CONFLICT";
        else if (original && quarantined == null && !committed && new string[] { "PREPARED", "DELETE_INTENT", "ROLLBACK_REQUIRED", "ROLLED_BACK" }.Contains(phase)) status = "OLD_COMPLETE_OBSERVED";
        else if (current == null && ownedQuarantine && last["tempIdentity"] != null && new string[] { "DELETE_INTENT", "DELETE_QUARANTINED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANUP_STARTED", "RECOVERY_REQUIRED" }.Contains(phase)) status = "DELETE_COMMITTED_QUARANTINE_RETAINED";
        else if (current == null && quarantined == null && committed && deleteCleanupIntent && new string[] { "CLEANUP_STARTED", "CLEANED", "RECOVERY_REQUIRED" }.Contains(phase)) status = "DELETE_COMMITTED_CLEANUP_OBSERVED";
        else if (current != null) status = "CONFLICT";
        int before = (int)last["sequence"];
        if (recover && status == "OLD_COMPLETE_OBSERVED" && phase != "ROLLED_BACK") {
          if (phase != "ROLLBACK_REQUIRED") Observe("ROLLBACK_REQUIRED", last["tempIdentity"] as string, null);
          Observe("ROLLED_BACK", last["tempIdentity"] as string, null);
        } else if (recover && status == "DELETE_COMMITTED_QUARANTINE_RETAINED" && phase != "RECOVERY_REQUIRED") {
          if (phase == "DELETE_INTENT") Observe("DELETE_QUARANTINED", (string)op["baseIdentity"], null);
          if ((string)last["phase"] == "DELETE_QUARANTINED") Observe("COMMITTED", (string)op["baseIdentity"], (string)op["baseIdentity"]);
          Observe("RECOVERY_REQUIRED", last["tempIdentity"] as string, last["committedIdentity"] as string);
        } else if (recover && status == "DELETE_COMMITTED_CLEANUP_OBSERVED" && phase != "CLEANED" && phase != "RECOVERY_REQUIRED") {
          Observe("RECOVERY_REQUIRED", last["tempIdentity"] as string, last["committedIdentity"] as string);
        }
        // A new process reconstructs the bound journal/operation and real IDs,
        // not the lost verified controller. Retain evidence, never auto-restore
        // over a user's new file, purge quarantine or mint PUBLISHED here.
        return new { status, metadata = Metadata(status), destinationMissing = current == null, quarantineMissing = quarantined == null,
          observedIdentity = current == null ? null : current.Identity, quarantineIdentity = quarantined == null ? null : quarantined.Identity,
          observedDigest = current == null ? null : current.Digest, quarantineDigest = quarantined == null ? null : quarantined.Digest,
          ownerGenerationAlive = false, journalMutations = (int)last["sequence"] - before, projectMutations = 0, processKills = 0,
          projectPublished = false, recoveryScope = "DELETE_FILESYSTEM_OBSERVATION_NOT_RESTORED_CONTROLLER_VERIFICATION" };
      }
    }
    internal static int RunSingleDelete(Stream input) {
      PublicationJournal journal = null; string phase = "REQUEST";
      try {
        Dictionary<string, object> request;
        using (MemoryStream line = new MemoryStream()) {
          bool complete = false;
          for (int i = 0; i < MaxBytes; i++) { int next = input.ReadByte(); if (next < 0) throw new InvalidDataException(); if (next == 10) { complete = true; break; } line.WriteByte((byte)next); }
          if (!complete) throw new InvalidDataException(); request = Serializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(line.ToArray()));
        }
        Keys(request, "version", "root", "header", "guardianPid", "timeoutMs"); Number(request, "version", 1, 1);
        string project = request["root"] as string;
        if (project == null || project.Length > 1024 || project.IndexOf('\0') >= 0 || !Path.IsPathRooted(project)) throw new InvalidDataException();
        Dictionary<string, object> header = request["header"] as Dictionary<string, object>;
        Keys(header, "transactionId", "projectIdentity", "draftId", "draftVersion", "verifiedDigest", "baseDigest", "operations");
        bool alive; int pid = Process.GetCurrentProcess().Id;
        header.Add("version", 3); header.Add("creatorPid", pid); header.Add("creatorGeneration", ScopeRecovery.ProcessCreation(pid, out alive));
        if (!alive) throw new InvalidDataException(); ValidateHeader(header, header["transactionId"] as string);
        object result = null;
        OwnedProcess.WithPublicationGuardian(Number(request, "guardianPid", 1, Int32.MaxValue), Number(request, "timeoutMs", 1, 30000), delegate(Action live) {
          phase = "ADMISSION"; journal = Begin(project, header); phase = "PREPARED";
          result = journal.PublishSingleDelete(delegate(string observed) { phase = observed; live(); });
        });
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_NATIVE_SINGLE_DELETE", receipt = result, projectPublished = false, externalRequests = 0 })); return 0;
      } catch (Exception error) {
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_NATIVE_SINGLE_DELETE", phase,
          reason = error is AdmissionConflict || error is InvalidOperationException && error.Message == "PHI_PUBLICATION_CONFLICT" ? "CONFLICT" : "UNCONFIRMED",
          nativeCode = unchecked((uint)Marshal.GetHRForException(error)).ToString("x8"), journal = journal == null ? null : journal.Metadata("INSPECTION_REQUIRED"),
          admission = error is AdmissionConflict ? ((AdmissionConflict)error).Evidence : null, projectPublished = false, externalRequests = 0 })); return 70;
      } finally { if (journal != null) journal.Dispose(); }
    }
    internal object PublishSingleRename(Action<string> checkpoint) {
      if ((int)header["version"] != 4 || (string)last["phase"] != "PREPARED") throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string[] sourceParts = AnchoredFile.Segments((string)op["sourcePath"]), targetParts = AnchoredFile.Segments((string)op["path"]);
      string sourcePath = sourceParts.Aggregate(project, (current, part) => Path.Combine(current, part));
      string expected = (string)op["baseIdentity"];
      IntPtr source = IntPtr.Zero; object primitive = null;
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(sourcePath))) {
        try {
          checkpoint("before-rename"); RecoveryFilesystem.Info info;
          try { source = parent.OpenRenameSource(sourceParts.Last(), out info); }
          catch (System.ComponentModel.Win32Exception error) { if (error.NativeErrorCode != 2) throw; throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT"); }
          DeleteObject held = ReadDeleteObject(source);
          if (!DeleteBaseMatches(held, op) || held.Bytes != (int)op["newBytes"] || ReadDeleteLeaf(parent, targetParts.Last()) != null)
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          // This exclusive source handle binds the durable intent to the same
          // object used by the no-replace native rename; destination races are
          // finally arbitrated by the kernel, never a pathname overwrite.
          Observe("RENAME_INTENT", expected, null); checkpoint("intent");
          if (!DeleteBaseMatches(ReadDeleteObject(source), op) || ReadDeleteLeaf(parent, targetParts.Last()) != null)
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          primitive = parent.RenameExpectedSource(source, sourceParts.Last(), targetParts.Last(), expected, (string)op["baseDigest"]);
          checkpoint("renamed"); // Death here leaves durable INTENT + real new object.
          Observe("RENAMED", expected, null); checkpoint("journal-renamed");
          if (ReadDeleteLeaf(parent, sourceParts.Last()) != null || !DeleteBaseMatches(ReadDeleteObject(source), op))
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          Observe("COMMITTED", expected, expected); checkpoint("committed");
          CloseNative(source); source = IntPtr.Zero;
          DeleteObject target = ReadDeleteLeaf(parent, targetParts.Last());
          if (ReadDeleteLeaf(parent, sourceParts.Last()) != null || !DeleteBaseMatches(target, op) || target.Bytes != (int)op["newBytes"])
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          Observe("POST_COMMIT_VERIFIED", expected, expected); checkpoint("verified");
          Observe("CLEANED", expected, expected); checkpoint("cleaned");
          return new { journal = Metadata("NOT_REQUIRED"), nativeProof = new { backend = "JOURNALED_HANDLE_ANCHORED_RENAME",
            primitive, sourceIdentity = expected, destinationIdentity = expected, digest = op["baseDigest"],
            sameDirectory = true, noClobber = true, committed = true, txfUsed = false, projectPublished = false } };
        } catch (InvalidOperationException error) {
          if (error.Message != "PHI_PUBLICATION_CONFLICT" && error.Message != "PHI_RENAME_SOURCE_CONFLICT") throw;
          if ((string)last["phase"] != "CONFLICT") Observe("CONFLICT", last["tempIdentity"] as string, last["committedIdentity"] as string);
          throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
        } catch (System.ComponentModel.Win32Exception error) {
          if (error.NativeErrorCode != 80 && error.NativeErrorCode != 183) throw;
          if ((string)last["phase"] != "CONFLICT") Observe("CONFLICT", last["tempIdentity"] as string, last["committedIdentity"] as string);
          throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
        } finally { CloseNative(source); }
      }
    }
    object InspectSingleRename(bool recover) {
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string[] sourceParts = AnchoredFile.Segments((string)op["sourcePath"]), targetParts = AnchoredFile.Segments((string)op["path"]);
      string sourcePath = sourceParts.Aggregate(project, (current, part) => Path.Combine(current, part));
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(sourcePath))) {
        DeleteObject source = ReadDeleteLeaf(parent, sourceParts.Last()), target = ReadDeleteLeaf(parent, targetParts.Last());
        string phase = (string)last["phase"], status = "UNKNOWN_FAIL_SAFE";
        bool old = DeleteBaseMatches(source, op) && source.Bytes == (int)op["newBytes"];
        bool next = DeleteBaseMatches(target, op) && target.Bytes == (int)op["newBytes"];
        bool committed = last["committedIdentity"] != null;
        if (phase == "CONFLICT" || source != null && !old || target != null && !next || source != null && target != null) status = "CONFLICT";
        else if (old && target == null && !committed && new string[] { "PREPARED", "RENAME_INTENT", "ROLLBACK_REQUIRED", "ROLLED_BACK" }.Contains(phase)) status = "OLD_COMPLETE_OBSERVED";
        else if (source == null && next && new string[] { "RENAME_INTENT", "RENAMED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED", "RECOVERY_REQUIRED" }.Contains(phase))
          status = "RENAME_COMMITTED_DESTINATION_RETAINED";
        int before = (int)last["sequence"];
        if (recover && status == "OLD_COMPLETE_OBSERVED" && phase != "ROLLED_BACK") {
          if (phase != "ROLLBACK_REQUIRED") Observe("ROLLBACK_REQUIRED", last["tempIdentity"] as string, null);
          Observe("ROLLED_BACK", last["tempIdentity"] as string, null);
        } else if (recover && status == "RENAME_COMMITTED_DESTINATION_RETAINED" && phase != "CLEANED" && phase != "RECOVERY_REQUIRED") {
          if (phase == "RENAME_INTENT") Observe("RENAMED", (string)op["baseIdentity"], null);
          if ((string)last["phase"] == "RENAMED") Observe("COMMITTED", (string)op["baseIdentity"], (string)op["baseIdentity"]);
          Observe("RECOVERY_REQUIRED", last["tempIdentity"] as string, last["committedIdentity"] as string);
        }
        // A fresh process can reconcile metadata against bound object IDs, not
        // recreate the departed controller's one-use verified-draft grant.
        return new { status, metadata = Metadata(status), sourceMissing = source == null, destinationMissing = target == null,
          sourceIdentity = source == null ? null : source.Identity, destinationIdentity = target == null ? null : target.Identity,
          sourceDigest = source == null ? null : source.Digest, destinationDigest = target == null ? null : target.Digest,
          ownerGenerationAlive = false, journalMutations = (int)last["sequence"] - before, projectMutations = 0, processKills = 0,
          projectPublished = false, recoveryScope = "RENAME_FILESYSTEM_OBSERVATION_NOT_RESTORED_CONTROLLER_VERIFICATION" };
      }
    }
    internal static int RunSingleRename(Stream input) {
      PublicationJournal journal = null; string phase = "REQUEST";
      try {
        Dictionary<string, object> request;
        using (MemoryStream line = new MemoryStream()) {
          bool complete = false;
          for (int i = 0; i < MaxBytes; i++) { int next = input.ReadByte(); if (next < 0) throw new InvalidDataException(); if (next == 10) { complete = true; break; } line.WriteByte((byte)next); }
          if (!complete) throw new InvalidDataException(); request = Serializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(line.ToArray()));
        }
        Keys(request, "version", "root", "header", "guardianPid", "timeoutMs"); Number(request, "version", 1, 1);
        string project = request["root"] as string;
        if (project == null || project.Length > 1024 || project.IndexOf('\0') >= 0 || !Path.IsPathRooted(project)) throw new InvalidDataException();
        Dictionary<string, object> header = request["header"] as Dictionary<string, object>;
        Keys(header, "transactionId", "projectIdentity", "draftId", "draftVersion", "verifiedDigest", "baseDigest", "operations");
        bool alive; int pid = Process.GetCurrentProcess().Id;
        header.Add("version", 4); header.Add("creatorPid", pid); header.Add("creatorGeneration", ScopeRecovery.ProcessCreation(pid, out alive));
        if (!alive) throw new InvalidDataException(); ValidateHeader(header, header["transactionId"] as string);
        object result = null;
        OwnedProcess.WithPublicationGuardian(Number(request, "guardianPid", 1, Int32.MaxValue), Number(request, "timeoutMs", 1, 30000), delegate(Action live) {
          phase = "ADMISSION"; journal = Begin(project, header); phase = "PREPARED";
          result = journal.PublishSingleRename(delegate(string observed) { phase = observed; live(); });
        });
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_NATIVE_SINGLE_RENAME", receipt = result, projectPublished = false, externalRequests = 0 })); return 0;
      } catch (Exception error) {
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_NATIVE_SINGLE_RENAME", phase,
          reason = error is AdmissionConflict || error is InvalidOperationException && error.Message == "PHI_PUBLICATION_CONFLICT" ? "CONFLICT" : "UNCONFIRMED",
          nativeCode = unchecked((uint)Marshal.GetHRForException(error)).ToString("x8"), journal = journal == null ? null : journal.Metadata("INSPECTION_REQUIRED"),
          admission = error is AdmissionConflict ? ((AdmissionConflict)error).Evidence : null, projectPublished = false, externalRequests = 0 })); return 70;
      } finally { if (journal != null) journal.Dispose(); }
    }
    void ReadChain(RegistryKey key) {
      ScopeRecovery.ValidateRegistry(key);
      if (key.GetSubKeyNames().Length != 0) throw new InvalidDataException();
      string[] names = key.GetValueNames().OrderBy(x => x, StringComparer.Ordinal).ToArray();
      if (names.Length < 1 || names.Length > MaxEvents) throw new InvalidDataException();
      string previous = new string('0', 64); Dictionary<string, object> prior = null, original = null; bool cleanupIntent = false;
      for (int i = 0; i < names.Length; i++) {
        if (names[i] != "E" + i.ToString("D8")) throw new InvalidDataException();
        byte[] bytes = ReadValue(key, names[i]); Dictionary<string, object> body = Decode(bytes);
        Keys(body, "sequence", "previousDigest", "phase", "operationIndex", "tempIdentity", "committedIdentity", "header");
        if (Number(body, "sequence", 0, MaxEvents - 1) != i || StringField(body, "previousDigest", Digest) != previous || !(body["phase"] is string) || !Phases.Contains((string)body["phase"])) throw new InvalidDataException();
        if (i == 0) { original = body["header"] as Dictionary<string, object>; ValidateHeader(original, id); if ((string)body["phase"] != "PREPARED" || Number(body, "operationIndex", 0, 0) != 0) throw new InvalidDataException(); }
        else if (body["header"] != null || !Transition((string)prior["phase"], (string)body["phase"], (int)prior["operationIndex"], Number(body, "operationIndex", 0, Operations(original).Count - 1), Operations(original).Count, (int)original["version"])) throw new InvalidDataException();
        foreach (string field in new string[] { "tempIdentity", "committedIdentity" }) if (body[field] != null) StringField(body, field, Identity);
        if (prior != null && prior["tempIdentity"] != null && (int)prior["operationIndex"] == (int)body["operationIndex"] && !Object.Equals(prior["tempIdentity"], body["tempIdentity"])) throw new InvalidDataException();
        if ((int)original["version"] == 1 && new string[] { "TEMP_CREATED", "COMMITTED", "VERIFIED", "POST_COMMIT_VERIFIED", "CLEANED" }.Contains((string)body["phase"])) throw new InvalidDataException();
        if ((int)original["version"] == 2) {
          string phase = (string)body["phase"], committed = body["committedIdentity"] as string;
          string expected = (string)((Dictionary<string, object>)Operations(original)[0])["baseIdentity"];
          if (new string[] { "TEMP_CREATED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }.Contains(phase) && body["tempIdentity"] == null) throw new InvalidDataException();
          if (new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }.Contains(phase) ? committed != expected : committed != null && committed != expected) throw new InvalidDataException();
          if (phase == "PREPARED" && (body["tempIdentity"] != null || committed != null)) throw new InvalidDataException();
        }
        if ((int)original["version"] == 3) {
          string phase = (string)body["phase"], committed = body["committedIdentity"] as string;
          string expected = (string)((Dictionary<string, object>)Operations(original)[0])["baseIdentity"];
          if (phase == "PREPARED" && (body["tempIdentity"] != null || committed != null)) throw new InvalidDataException();
          if (body["tempIdentity"] != null && (string)body["tempIdentity"] != expected || committed != null && committed != expected) throw new InvalidDataException();
          if (new string[] { "DELETE_INTENT", "DELETE_QUARANTINED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANUP_STARTED", "CLEANED" }.Contains(phase) && (string)body["tempIdentity"] != expected) throw new InvalidDataException();
          if (new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANUP_STARTED", "CLEANED" }.Contains(phase) && committed != expected) throw new InvalidDataException();
          if (new string[] { "PREPARED", "DELETE_INTENT", "DELETE_QUARANTINED", "ROLLBACK_REQUIRED", "ROLLED_BACK" }.Contains(phase) && committed != null) throw new InvalidDataException();
          if (prior != null && prior["committedIdentity"] != null && !Object.Equals(prior["committedIdentity"], committed)) throw new InvalidDataException();
          if (phase == "CLEANUP_STARTED") cleanupIntent = true;
        }
        if ((int)original["version"] == 4) {
          string phase = (string)body["phase"], committed = body["committedIdentity"] as string;
          string expected = (string)((Dictionary<string, object>)Operations(original)[0])["baseIdentity"];
          if (phase == "PREPARED" && (body["tempIdentity"] != null || committed != null)) throw new InvalidDataException();
          if (body["tempIdentity"] != null && (string)body["tempIdentity"] != expected || committed != null && committed != expected) throw new InvalidDataException();
          if (new string[] { "RENAME_INTENT", "RENAMED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }.Contains(phase) && (string)body["tempIdentity"] != expected) throw new InvalidDataException();
          if (new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }.Contains(phase) && committed != expected) throw new InvalidDataException();
          if (new string[] { "PREPARED", "RENAME_INTENT", "RENAMED", "ROLLBACK_REQUIRED", "ROLLED_BACK" }.Contains(phase) && committed != null) throw new InvalidDataException();
          if (prior != null && prior["committedIdentity"] != null && !Object.Equals(prior["committedIdentity"], committed)) throw new InvalidDataException();
        }
        previous = Hash(bytes); prior = body;
      }
      if (lastDigest != null && previous != lastDigest) throw new InvalidDataException();
      header = original; last = prior; lastDigest = previous; deleteCleanupIntent = cleanupIntent;
    }
    internal object Metadata(string recovery) {
      if ((int)header["version"] >= 2) return new { version = (int)header["version"], scope = (int)header["version"] == 4 ? "SINGLE_FILE_RENAME_JOURNAL_NOT_CONTROLLER_PUBLICATION" : (int)header["version"] == 3 ? "SINGLE_FILE_DELETE_JOURNAL_NOT_CONTROLLER_PUBLICATION" : "SINGLE_FILE_MODIFY_JOURNAL_NOT_CONTROLLER_PUBLICATION", transactionId = id,
        projectIdentity = header["projectIdentity"], draftId = header["draftId"], draftVersion = header["draftVersion"], verifiedDigest = header["verifiedDigest"], baseDigest = header["baseDigest"],
        phase = last["phase"], sequence = last["sequence"], operationIndex = last["operationIndex"], operations = header["operations"], tempIdentity = last["tempIdentity"], committedIdentity = last["committedIdentity"],
        filesCommitted = last["committedIdentity"] == null ? new string[0] : new string[] { (string)((Dictionary<string, object>)Operations(header)[0])["path"] },
        pendingOperations = last["committedIdentity"] == null ? 1 : 0, recoveryState = recovery, cleanup = (string)last["phase"] == "CLEANED" ? "PASS" : "NOT_PROVEN", projectPublished = false };
      return new { version = 1, scope = "DURABLE_JOURNAL_NOT_PROJECT_PUBLICATION", transactionId = id, projectIdentity = header["projectIdentity"], draftId = header["draftId"], draftVersion = header["draftVersion"], verifiedDigest = header["verifiedDigest"], baseDigest = header["baseDigest"],
        phase = last["phase"], sequence = last["sequence"], operationIndex = last["operationIndex"], operations = header["operations"], tempIdentity = last["tempIdentity"], committedIdentity = last["committedIdentity"],
        filesCommitted = new string[0], pendingOperations = Operations(header).Count, recoveryState = recovery, cleanup = "NOT_PERFORMED", projectPublished = false };
    }
    internal static object Inspect(string transactionId, string project, string expectedProjectIdentity, bool recover = false) {
      // Read-only unless explicit V2 metadata recovery is requested. Never
      // modifies/removes project/temp files or keys, kills a PID, guesses
      // ownership or infers commit from a temporary file.
      if (!Id.IsMatch(transactionId) || !Identity.IsMatch(expectedProjectIdentity)) throw new InvalidDataException();
      using (Mutex mutex = Lease(transactionId)) {
        if (!Acquire(mutex)) return new { status = "ACTIVE", projectMutations = 0, journalMutations = 0, processKills = 0, projectPublished = false };
        try {
          using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(transactionId, false)) {
            if (key == null) throw new InvalidDataException();
            // This object borrows the already-held lease only for parsing.
            using (PublicationJournal parsed = new PublicationJournal(transactionId, project)) {
              parsed.ReadChain(key);
              if ((string)parsed.header["projectIdentity"] != expectedProjectIdentity || RecoveryFilesystem.HandleIdentity(parsed.pins.DirectoryHandle) != expectedProjectIdentity) throw new InvalidDataException();
              bool alive; string generation = ScopeRecovery.ProcessCreation((int)parsed.header["creatorPid"], out alive);
              if (alive && generation == (string)parsed.header["creatorGeneration"]) return new { status = "ACTIVE", projectMutations = 0, journalMutations = 0, processKills = 0, projectPublished = false };
              if ((int)parsed.header["version"] == 2) return parsed.InspectSingleModify(recover);
              if ((int)parsed.header["version"] == 3) return parsed.InspectSingleDelete(recover);
              if ((int)parsed.header["version"] == 4) return parsed.InspectSingleRename(recover);
              if (recover) throw new InvalidDataException();
              bool unchanged = MatchesBase(project, parsed.header);
              return new { status = unchanged ? "RECOVERY_REQUIRED" : "CONFLICT", metadata = parsed.Metadata(unchanged ? "RECOVERY_REQUIRED" : "CONFLICT"), ownerGenerationAlive = false, baseMatches = unchanged,
                projectMutations = 0, journalMutations = 0, processKills = 0, projectPublished = false };
            }
          }
        } finally { mutex.ReleaseMutex(); }
      }
    }
    internal static int InspectKnownTransaction(Stream input) {
      // Trusted-controller, read-only restart bridge for a known transaction.
      // A caller supplies a project root and transaction ID, never a claimed
      // root identity, publication grant, executable, profile or recovery mode.
      // Discovery and mutation of retained evidence are separate D units.
      try {
        Dictionary<string, object> request;
        using (MemoryStream line = new MemoryStream()) {
          bool complete = false;
          for (int i = 0; i < MaxBytes; i++) {
            int next = input.ReadByte(); if (next < 0) throw new InvalidDataException();
            if (next == 10) { complete = true; break; } line.WriteByte((byte)next);
          }
          if (!complete) throw new InvalidDataException();
          request = Serializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(line.ToArray()));
        }
        Keys(request, "version", "root", "transactionId"); Number(request, "version", 1, 1);
        string project = request["root"] as string, transactionId = StringField(request, "transactionId", Id);
        if (project == null || project.Length > 1024 || project.IndexOf('\0') >= 0 || !Path.IsPathRooted(project)) throw new InvalidDataException();
        string rootIdentity;
        using (RecoveryFilesystem root = new RecoveryFilesystem(project)) rootIdentity = RecoveryFilesystem.HandleIdentity(root.DirectoryHandle);
        Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(Inspect(transactionId, project, rootIdentity, false)));
        string state = observed["status"] as string;
        // ACTIVE can be returned before the journal/root binding is read (a
        // contended lease). It is never a successful reconstruction receipt.
        if (state == null || !new string[] { "OLD_COMPLETE_OBSERVED", "NEW_COMPLETE_OBSERVED", "DELETE_COMMITTED_QUARANTINE_RETAINED",
            "DELETE_COMMITTED_CLEANUP_OBSERVED", "RENAME_COMMITTED_DESTINATION_RETAINED", "CONFLICT", "UNKNOWN_FAIL_SAFE", "RECOVERY_REQUIRED" }.Contains(state) ||
            (int)observed["projectMutations"] != 0 || (int)observed["journalMutations"] != 0 || (int)observed["processKills"] != 0 || (bool)observed["projectPublished"]) throw new InvalidDataException();
        Dictionary<string, object> metadata = observed.ContainsKey("metadata") ? observed["metadata"] as Dictionary<string, object> : null;
        if (metadata == null || (string)metadata["projectIdentity"] != rootIdentity || (string)metadata["transactionId"] != transactionId ||
            (bool)metadata["projectPublished"]) throw new InvalidDataException();
        // OLD is physically intact, so a fresh controller may select rollback
        // for separate authorized metadata reconciliation. No action here.
        // NEW cannot reconstruct the lost one-use verified-draft certificate.
        string decision = state == "OLD_COMPLETE_OBSERVED" ? "ROLLBACK" : state == "CONFLICT" ? "CONFLICT" : "MANUAL_RECOVERY_REQUIRED";
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_READ_ONLY_RECONSTRUCTION", transactionId, rootIdentity,
          rootIdentityVerified = true, observedStatus = state, decision,
          phase = metadata["phase"], journalVersion = metadata["version"],
          actionPerformed = false, journalMutations = 0, projectMutations = 0, processKills = 0, projectPublished = false, externalRequests = 0 }));
        return 0;
      } catch {
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_READ_ONLY_RECONSTRUCTION", decision = "MANUAL_RECOVERY_REQUIRED",
          actionPerformed = false, journalMutations = 0, projectMutations = 0, processKills = 0, projectPublished = false, externalRequests = 0 }));
        return 70;
      }
    }
    public void Dispose() {
      if (disposed) return; disposed = true;
      if (pins != null) pins.Dispose();
      if (lease != null) { if (acquired) { acquired = false; lease.ReleaseMutex(); } lease.Dispose(); }
    }

    // Fixed fixtures only. No arbitrary project/transaction or write endpoint.
    static readonly string[] RenamePrimitiveCases = { "normal", "destination-exists", "destination-created-after-lock", "case-alias-destination", "same-source-alias",
      "expected-id-mismatch", "expected-digest-mismatch", "source-name-mismatch", "foreign-owner", "create-handle", "delete-handle",
      "protected-destination", "reserved-destination", "cross-parent-destination", "traversal-destination", "ads-destination",
      "source-sharing", "pinned-parent", "source-writer-denied", "consumed-authority" };
    internal static int RenamePrimitiveSelfTest(string name) {
      // One fixed batch, only fresh owned scopes. No caller path, journal,
      // verified-draft/controller authority or arbitrary native execution.
      if (name != "same-parent") return 70;
      var receipts = new List<object>(); bool passed = true;
      foreach (string control in RenamePrimitiveCases) {
        bool ok; receipts.Add(RenamePrimitiveCase(control, out ok)); if (!ok) { passed = false; break; }
      }
      Console.WriteLine(Serializer().Serialize(new { version = 1, status = passed ? "PASS" : "FAIL", scope = "NATIVE_RENAME_PRIMITIVE_NOT_JOURNAL_OR_PUBLICATION",
        expectedCases = RenamePrimitiveCases.Length, completedCases = receipts.Count, receipts, journalUsed = false,
        recoveryImplemented = false, projectPublished = false, txfUsed = false, externalRequests = 0 }));
      return passed ? 0 : 70;
    }
    static object RenamePrimitiveCase(string name, out bool ok) {
      ScopeRecovery scope = null; IntPtr file = IntPtr.Zero; FileStream sharing = null;
      bool passed = false, clean = false, denied = false, moved = false, writerDenied = false, parentRenameDenied = false, consumed = false;
      string stage = "BEGIN", originalId = null, originalDigest = null, sourceId = null, sourceDigest = null, destinationId = null, destinationDigest = null;
      string collisionId = null, collisionDigest = null; object proof = null; int? rejectionCode = null;
      bool securityPreserved = false, creationPreserved = false, unrelatedPreserved = false;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        string sourcePath = Path.Combine(scope.Root, "input.txt"), targetPath = Path.Combine(scope.Root, "renamed.txt");
        string unrelated = Path.Combine(scope.Root, "unrelated.txt");
        File.WriteAllText(sourcePath, "rename-original-complete", new UTF8Encoding(false));
        File.WriteAllText(unrelated, "rename-unrelated-user", new UTF8Encoding(false));
        string security = File.GetAccessControl(sourcePath).GetSecurityDescriptorSddlForm(AccessControlSections.All);
        DateTime created = File.GetCreationTimeUtc(sourcePath);
        using (RecoveryFilesystem parent = new RecoveryFilesystem(scope.Root)) {
          DeleteObject original = ReadDeleteLeaf(parent, "input.txt"); originalId = original.Identity; originalDigest = original.Digest;
          string collision = name == "case-alias-destination" ? "RENAMED.txt" : "renamed.txt";
          if (name == "destination-exists" || name == "case-alias-destination") File.WriteAllText(Path.Combine(scope.Root, collision), "rename-new-user", new UTF8Encoding(false));
          if (name == "source-sharing") sharing = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read);
          stage = "SOURCE_OPEN";
          RecoveryFilesystem.Info info;
          try {
            file = name == "create-handle" ? parent.CreateExclusiveFile("created.txt", out info) : name == "delete-handle" ? parent.OpenDeleteSource("input.txt", out info) : parent.OpenRenameSource("input.txt", out info);
          } catch (System.ComponentModel.Win32Exception error) {
            if (name != "source-sharing" || error.NativeErrorCode != 32 && error.NativeErrorCode != 33) throw;
            denied = true; rejectionCode = error.NativeErrorCode;
          }
          if (sharing != null) { sharing.Dispose(); sharing = null; }
          if (name == "destination-created-after-lock") File.WriteAllText(targetPath, "rename-new-user", new UTF8Encoding(false));
          if (name == "destination-exists" || name == "case-alias-destination" || name == "destination-created-after-lock") {
            DeleteObject user = ReadDeleteLeaf(parent, collision); collisionId = user.Identity; collisionDigest = user.Digest;
          }
          if (file != IntPtr.Zero) {
            stage = "PRE_RENAME_CONTROLS";
            if (name == "source-writer-denied") {
              try { File.WriteAllText(sourcePath, "rename-writer-forbidden", new UTF8Encoding(false)); }
              catch (IOException error) { uint code = unchecked((uint)Marshal.GetHRForException(error)); if (code != 0x80070020U && code != 0x80070021U) throw; writerDenied = true; }
              if (!writerDenied) throw new InvalidDataException();
            }
            if (name == "pinned-parent") {
              try { Directory.Move(scope.Root, scope.Root + ".user-owned"); }
              catch (IOException error) { if (unchecked((uint)Marshal.GetHRForException(error)) != 0x80070020U) throw; parentRenameDenied = true; }
              if (!parentRenameDenied) throw new InvalidDataException();
            }
            string sourceName = name == "source-name-mismatch" ? "unrelated.txt" : "input.txt";
            string destination = name == "same-source-alias" ? "INPUT.txt" : name == "protected-destination" ? ".env" : name == "reserved-destination" ? DeleteLeaf(Guid.NewGuid().ToString("N")) :
              name == "cross-parent-destination" ? "nested/renamed.txt" : name == "traversal-destination" ? "../escape.txt" : name == "ads-destination" ? "renamed.txt:ads" : "renamed.txt";
            string expected = name == "expected-id-mismatch" ? new string('a', 16) + ":" + new string('b', 32) : originalId;
            string digest = name == "expected-digest-mismatch" ? new string('a', 64) : originalDigest;
            stage = "RENAME";
            try {
              if (name == "foreign-owner") using (RecoveryFilesystem foreign = new RecoveryFilesystem(scope.Root)) { proof = foreign.RenameExpectedSource(file, sourceName, destination, expected, digest); }
              else proof = parent.RenameExpectedSource(file, sourceName, destination, expected, digest);
              moved = true;
            } catch (System.ComponentModel.Win32Exception error) {
              if (!(name == "destination-exists" || name == "case-alias-destination" || name == "destination-created-after-lock") || error.NativeErrorCode != 80 && error.NativeErrorCode != 183) throw;
              denied = true; rejectionCode = error.NativeErrorCode;
            } catch (InvalidOperationException error) {
              if (!(name == "expected-id-mismatch" || name == "expected-digest-mismatch") || error.Message != "PHI_RENAME_SOURCE_CONFLICT") throw; denied = true;
            } catch (InvalidDataException) {
              if (!(name == "same-source-alias" || name == "source-name-mismatch" || name == "foreign-owner" || name == "create-handle" || name == "delete-handle" ||
                name == "protected-destination" || name == "reserved-destination" || name == "cross-parent-destination" || name == "traversal-destination" || name == "ads-destination")) throw;
              denied = true;
            }
            if (name == "consumed-authority") {
              bool unlinkDenied = false, repeatDenied = false, createDenied = false, quarantineDenied = false;
              try { parent.UnlinkQuarantinedFile(file, originalId); } catch (InvalidDataException) { unlinkDenied = true; }
              try { parent.RenameExpectedSource(file, "input.txt", "again.txt", originalId, originalDigest); } catch (InvalidDataException) { repeatDenied = true; }
              try { parent.RenameNewFile(file, "again.txt"); } catch (InvalidDataException) { createDenied = true; }
              try { parent.QuarantineDeleteSource(file, DeleteLeaf(Guid.NewGuid().ToString("N"))); } catch (InvalidDataException) { quarantineDenied = true; }
              consumed = unlinkDenied && repeatDenied && createDenied && quarantineDenied; if (!consumed) throw new InvalidDataException();
            }
          }
          CloseNative(file); file = IntPtr.Zero; stage = "READBACK";
          DeleteObject actualSource = ReadDeleteLeaf(parent, "input.txt"), actualDestination = ReadDeleteLeaf(parent, collision);
          sourceId = actualSource == null ? null : actualSource.Identity; sourceDigest = actualSource == null ? null : actualSource.Digest;
          destinationId = actualDestination == null ? null : actualDestination.Identity; destinationDigest = actualDestination == null ? null : actualDestination.Digest;
          bool expectedMove = name == "normal" || name == "source-writer-denied" || name == "pinned-parent" || name == "consumed-authority";
          if (moved != expectedMove || denied == expectedMove || (expectedMove ? actualSource != null || destinationId != originalId || destinationDigest != originalDigest : sourceId != originalId || sourceDigest != originalDigest)) throw new InvalidDataException();
          if (collisionId == null ? !expectedMove && actualDestination != null : destinationId != collisionId || destinationDigest != collisionDigest) throw new InvalidDataException();
        }
        string retainedPath = moved ? targetPath : sourcePath;
        securityPreserved = File.GetAccessControl(retainedPath).GetSecurityDescriptorSddlForm(AccessControlSections.All) == security;
        creationPreserved = File.GetCreationTimeUtc(retainedPath) == created;
        unrelatedPreserved = File.ReadAllText(unrelated) == "rename-unrelated-user";
        if (!securityPreserved || !creationPreserved || !unrelatedPreserved) throw new InvalidDataException();
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_RENAME_PRIMITIVE_FAILED:" + name + ":" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8")); }
      finally {
        CloseNative(file); if (sharing != null) sharing.Dispose();
        try { if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); } }
        catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      ok = passed && clean;
      return new { caseName = name, passed, fixtureCleanup = clean, denied, moved, rejectionCode, originalId, originalDigest,
        sourceId, sourceDigest, destinationId, destinationDigest, collisionId, collisionDigest, proof,
        securityPreserved, creationPreserved, unrelatedPreserved, writerDenied, parentRenameDenied, consumedAuthorityDenied = consumed };
    }
    static Dictionary<string, object> FixtureRequest() {
      using (Stream input = Console.OpenStandardInput()) using (MemoryStream line = new MemoryStream()) {
        for (int i = 0; i < 2048; i++) {
          int next = input.ReadByte(); if (next < 0) throw new InvalidDataException();
          if (next != 10) { line.WriteByte((byte)next); continue; }
          Dictionary<string, object> request = Serializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(line.ToArray()));
          Keys(request, "scopeId", "rootIdentity", "transactionId");
          string scopeId = StringField(request, "scopeId", Id), identity = StringField(request, "rootIdentity", Identity);
          StringField(request, "transactionId", Id); ScopeRecovery.ValidateLiveRoot(scopeId, identity); return request;
        }
      }
      throw new InvalidDataException();
    }
    static Dictionary<string, object> FixtureHeader(string project, string transactionId) {
      Dictionary<string, object> snapshot = Snapshot(project, RecoveryFilesystem.DirectoryIdentity(project));
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"], identities = (Dictionary<string, object>)snapshot["identities"];
      bool alive; int pid = Process.GetCurrentProcess().Id;
      return new Dictionary<string, object> {
        { "version", 1 }, { "transactionId", transactionId }, { "projectIdentity", snapshot["rootIdentity"] }, { "draftId", Guid.NewGuid().ToString("N") }, { "draftVersion", 1 },
        { "verifiedDigest", Hash(Encoding.UTF8.GetBytes("fixed-draft-digest-fixture")) }, { "baseDigest", Hash(Encoding.UTF8.GetBytes("fixed-base-digest-fixture")) }, { "creatorPid", pid }, { "creatorGeneration", ScopeRecovery.ProcessCreation(pid, out alive) },
        { "operations", new object[] { new Dictionary<string, object> { { "path", "input.txt" }, { "kind", "REPLACE" }, { "baseIdentity", identities["input.txt"] }, { "baseDigest", Hash(Encoding.UTF8.GetBytes((string)files["input.txt"])) }, { "newDigest", Hash(Encoding.UTF8.GetBytes("new-complete")) }, { "newBytes", 12 } } } }
      };
    }
    internal static int FixtureChild(string phase) {
      if (!new string[] { "PREPARED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED" }.Contains(phase)) return 70;
      try {
        // ACL/generation/live-lease/root-ID verified; no cleanup capability.
        Dictionary<string, object> request = FixtureRequest();
        string scopeId = StringField(request, "scopeId", Id), identity = StringField(request, "rootIdentity", Identity), tx = StringField(request, "transactionId", Id);
        string root = Path.Combine(ScopeRecovery.RootBase, scopeId);
        if (RecoveryFilesystem.DirectoryIdentity(root) != identity) throw new InvalidDataException();
        using (PublicationJournal journal = Begin(root, FixtureHeader(root, tx))) {
          foreach (string next in new string[] { "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED" }) {
            if (phase == (string)journal.last["phase"]) break;
            // These are journal state controls ONLY, not physical write/flush
            // certificates. Publication remains false and no target is modified.
            journal.Advance(next, null);
          }
          Console.WriteLine(Serializer().Serialize(new { ready = true, phase = journal.last["phase"], transactionId = tx })); Console.Out.Flush();
          Thread.Sleep(12000); return 70;
        }
      } catch { Console.Error.WriteLine("PHI_JOURNAL_FIXTURE_CHILD_FAILED"); return 70; }
    }
    internal static int FixtureInspect() {
      try {
        Dictionary<string, object> request = FixtureRequest();
        Console.WriteLine(Serializer().Serialize(Inspect((string)request["transactionId"], Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]), (string)request["rootIdentity"]))); return 0;
      } catch { Console.Error.WriteLine("PHI_JOURNAL_FIXTURE_INSPECT_FAILED"); return 70; }
    }
    static readonly string[] ModifyCheckpoints = { "before-transaction", "temp", "write", "flush", "validation", "staged", "before-commit", "before-journal-committed", "committed", "postverify", "cleanup" };
    static readonly string[] DeleteCheckpoints = { "before-delete", "intent", "renamed", "quarantined", "committed", "verified", "cleanup-started", "unlinked", "cleaned" };
    static Dictionary<string, object> DeleteFixtureHeader(string project, string transactionId) {
      Dictionary<string, object> header = FixtureHeader(project, transactionId); header["version"] = 3;
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0]; op["kind"] = "DELETE"; op["newDigest"] = null; op["newBytes"] = null;
      return header;
    }
    internal static int DeleteFixtureChild(string point) {
      if (!DeleteCheckpoints.Contains(point)) return 70;
      try {
        Dictionary<string, object> request = FixtureRequest(); string root = Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]);
        using (PublicationJournal journal = Begin(root, DeleteFixtureHeader(root, (string)request["transactionId"]))) {
          journal.PublishSingleDelete(delegate(string observed) {
            if (observed != point) return;
            Console.WriteLine(Serializer().Serialize(new { ready = true, checkpoint = point, phase = journal.last["phase"], transactionId = request["transactionId"] }));
            Console.Out.Flush(); Thread.Sleep(12000); throw new IOException("PHI_DELETE_KILL_FIXTURE_NOT_TERMINATED");
          });
        }
      } catch { Console.Error.WriteLine("PHI_DELETE_FIXTURE_CHILD_FAILED"); } return 70;
    }
    internal static int DeleteFixtureRecover() {
      try {
        Dictionary<string, object> request = FixtureRequest();
        Console.WriteLine(Serializer().Serialize(Inspect((string)request["transactionId"], Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]), (string)request["rootIdentity"], true))); return 0;
      } catch { Console.Error.WriteLine("PHI_DELETE_FIXTURE_RECOVERY_FAILED"); return 70; }
    }
    internal static int DeleteSelfTest(string name) {
      string[] controls = { "normal", "already-missing", "concurrent-modification", "delete-recreate", "replacement-before-mutation", "unauthorized-delete", "protected", "reserved-target", "root-identity", "sharing", "quarantine-collision", "unobserved-advance",
        "user-recreate-after-crash", "same-text-recreate-after-crash", "quarantine-replace-after-crash", "quarantine-missing-after-crash" };
      if (!controls.Contains(name) && !(name.StartsWith("crash-") && DeleteCheckpoints.Contains(name.Substring(6)))) return 70;
      ScopeRecovery scope = null; PublicationJournal journal = null; Process child = null;
      string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN"; bool passed = false, clean = false, killed = false, childGone = false, restarted = false, sameTextReplacementObserved = false;
      object evidence = null; string phaseAtDeath = null;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready(); string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        string target = Path.Combine(scope.Root, "input.txt"), unrelated = Path.Combine(scope.Root, "unrelated.txt"), quarantine = Path.Combine(scope.Root, DeleteLeaf(tx));
        File.WriteAllText(target, "old-delete-complete", new UTF8Encoding(false)); File.WriteAllText(unrelated, "unrelated-delete-user", new UTF8Encoding(false));
        bool crash = name.StartsWith("crash-") || name.EndsWith("after-crash");
        if (crash) {
          string point = name.StartsWith("crash-") ? name.Substring(6) : "quarantined";
          child = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-delete-fixture-child " + point,
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
          child.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); child.StandardInput.Close();
          string ready = null; Thread reader = new Thread(delegate() { try { ready = child.StandardOutput.ReadLine(); } catch { } }); reader.IsBackground = true; reader.Start();
          if (!reader.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
          Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
          if (!(bool)announcement["ready"] || (string)announcement["checkpoint"] != point || (string)announcement["transactionId"] != tx) throw new InvalidDataException();
          phaseAtDeath = (string)announcement["phase"]; stage = "KILL";
          child.Kill(); killed = true; if (!child.WaitForExit(3000) || !child.HasExited || child.ExitCode == 0) throw new InvalidDataException(); childGone = true;
          bool old = point == "before-delete" || point == "intent", removed = point == "unlinked" || point == "cleaned";
          if (old ? !File.Exists(target) || File.ReadAllText(target) != "old-delete-complete" : File.Exists(target)) throw new InvalidDataException();
          if (File.Exists(quarantine) != (!old && !removed) || File.Exists(quarantine) && File.ReadAllText(quarantine) != "old-delete-complete") throw new InvalidDataException();
          if (name == "user-recreate-after-crash") File.WriteAllText(target, "new-delete-user", new UTF8Encoding(false));
          if (name == "same-text-recreate-after-crash") File.WriteAllText(target, "old-delete-complete", new UTF8Encoding(false));
          if (name == "quarantine-replace-after-crash") { File.Move(quarantine, quarantine + ".user-owned"); File.WriteAllText(quarantine, "old-delete-complete", new UTF8Encoding(false)); }
          if (name == "quarantine-missing-after-crash") File.Move(quarantine, quarantine + ".user-owned");
          stage = "NEW_PROCESS_RECOVERY";
          using (Process recovery = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-delete-fixture-recover",
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
            try {
              recovery.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); recovery.StandardInput.Close();
              if (!recovery.WaitForExit(5000) || recovery.ExitCode != 0) throw new InvalidDataException();
              string output = recovery.StandardOutput.ReadToEnd(); if (output.Length > 16384) throw new InvalidDataException();
              Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(output); evidence = result; restarted = true;
              string expectedStatus = name == "quarantine-missing-after-crash" ? "UNKNOWN_FAIL_SAFE" : name.EndsWith("after-crash") ? "CONFLICT" : old ? "OLD_COMPLETE_OBSERVED" : removed ? "DELETE_COMMITTED_CLEANUP_OBSERVED" : "DELETE_COMMITTED_QUARANTINE_RETAINED";
              if ((string)result["status"] != expectedStatus || (bool)result["ownerGenerationAlive"] || (bool)result["projectPublished"] || (int)result["projectMutations"] != 0 || (int)result["processKills"] != 0) throw new InvalidDataException();
              Dictionary<string, object> metadata = (Dictionary<string, object>)result["metadata"];
              string expectedPhase = name.EndsWith("after-crash") ? phaseAtDeath : old ? "ROLLED_BACK" : point == "cleaned" ? "CLEANED" : "RECOVERY_REQUIRED";
              if ((string)metadata["phase"] != expectedPhase || name.EndsWith("after-crash") && (int)result["journalMutations"] != 0) throw new InvalidDataException();
            } finally { if (!recovery.HasExited) { recovery.Kill(); recovery.WaitForExit(3000); } }
          }
          if (name == "user-recreate-after-crash" && File.ReadAllText(target) != "new-delete-user" || name == "same-text-recreate-after-crash" && File.ReadAllText(target) != "old-delete-complete") throw new InvalidDataException();
          if (File.Exists(quarantine) != (!old && !removed && name != "quarantine-missing-after-crash")) throw new InvalidDataException();
        } else {
          Dictionary<string, object> header = DeleteFixtureHeader(scope.Root, tx);
          if (name == "delete-recreate") { File.Move(target, target + ".user-owned"); File.WriteAllText(target, "old-delete-complete", new UTF8Encoding(false)); }
          if (name == "unauthorized-delete") ((Dictionary<string, object>)Operations(header)[0])["kind"] = "CREATE";
          if (name == "protected") ((Dictionary<string, object>)Operations(header)[0])["path"] = ".env";
          if (name == "reserved-target") ((Dictionary<string, object>)Operations(header)[0])["path"] = DeleteLeaf(Guid.NewGuid().ToString("N"));
          if (name == "root-identity") header["projectIdentity"] = new string('a', 16) + ":" + new string('b', 32);
          if (name == "delete-recreate" || name == "unauthorized-delete" || name == "protected" || name == "reserved-target" || name == "root-identity") {
            bool denied = false; try { using (PublicationJournal rejected = Begin(scope.Root, header)) { } } catch (Exception error) { denied = error is AdmissionConflict || error is InvalidDataException; }
            if (!denied || !File.Exists(target) || File.Exists(quarantine)) throw new InvalidDataException(); evidence = new { rejected = true, journalAbsent = true, mutationStarted = false };
          } else {
            journal = Begin(scope.Root, header);
            if (name == "unobserved-advance") {
              bool denied = false; try { journal.Advance("DELETE_INTENT", (string)((Dictionary<string, object>)Operations(header)[0])["baseIdentity"]); } catch (InvalidOperationException) { denied = true; }
              if (!denied || (string)journal.last["phase"] != "PREPARED") throw new InvalidDataException();
            } else if (name == "sharing") {
              using (FileStream hold = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                bool denied = false; try { journal.PublishSingleDelete(delegate(string p) { }); } catch (System.ComponentModel.Win32Exception error) { denied = error.NativeErrorCode == 32 || error.NativeErrorCode == 33; }
                if (!denied || !File.Exists(target) || File.Exists(quarantine)) throw new InvalidDataException();
              }
            } else {
              if (name == "quarantine-collision") File.WriteAllText(quarantine, "new-delete-user", new UTF8Encoding(false));
              bool failed = false;
              try { evidence = journal.PublishSingleDelete(delegate(string p) {
                if (p != "before-delete") return;
                if (name == "already-missing") File.Delete(target);
                if (name == "concurrent-modification") File.WriteAllText(target, "new-delete-user", new UTF8Encoding(false));
                if (name == "replacement-before-mutation") {
                  // Real legal same-directory replacement under pinned parents.
                  // .NET File.Move reopens directory WRITE_DATA and was denied
                  // by the existing sharing pins (CI36573711599/80070020).
                  // Do not relax pins: use the independently opened file object.
                  using (RecoveryFilesystem user = new RecoveryFilesystem(scope.Root)) {
                    RecoveryFilesystem.Info info; IntPtr file = user.OpenDeleteSource("input.txt", out info);
                    try { user.QuarantineDeleteSource(file, "input.txt.user-owned"); } finally { CloseNative(file); }
                  }
                  File.WriteAllText(target, "old-delete-complete", new UTF8Encoding(false));
                }
              }); } catch (InvalidOperationException error) { if (error.Message != "PHI_PUBLICATION_CONFLICT") throw; failed = true; }
              catch (System.ComponentModel.Win32Exception error) { if (name != "quarantine-collision" || error.NativeErrorCode != 80 && error.NativeErrorCode != 183) throw; failed = true; }
              if (failed != (name != "normal")) throw new InvalidDataException();
              if (name == "replacement-before-mutation") {
                using (RecoveryFilesystem observer = new RecoveryFilesystem(scope.Root)) {
                  Dictionary<string, object> original = (Dictionary<string, object>)Operations(header)[0];
                  DeleteObject replacement = ReadDeleteLeaf(observer, "input.txt"), preserved = ReadDeleteLeaf(observer, "input.txt.user-owned");
                  if (replacement == null || replacement.Identity == (string)original["baseIdentity"] || replacement.Digest != (string)original["baseDigest"] ||
                      !DeleteBaseMatches(preserved, original) || (string)journal.last["phase"] != "CONFLICT" || journal.last["tempIdentity"] != null || journal.last["committedIdentity"] != null)
                    throw new InvalidDataException();
                  sameTextReplacementObserved = true;
                }
              }
              if (name == "normal" ? File.Exists(target) || File.Exists(quarantine) || (string)journal.last["phase"] != "CLEANED" : name == "already-missing" ? File.Exists(target) : !File.Exists(target)) throw new InvalidDataException();
              if (name == "concurrent-modification" && File.ReadAllText(target) != "new-delete-user" || name == "quarantine-collision" && File.ReadAllText(quarantine) != "new-delete-user") throw new InvalidDataException();
            }
            if (evidence == null) evidence = journal.Metadata("RETAINED");
          }
        }
        if (File.ReadAllText(unrelated) != "unrelated-delete-user") throw new InvalidDataException(); passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_DELETE_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8")); }
      finally {
        if (journal != null) journal.Dispose();
        if (child != null) { try { if (!child.HasExited) { child.Kill(); child.WaitForExit(3000); } } finally { child.Dispose(); } }
        try {
          // Original fixture owner only; production recovery never deletes keys.
          using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean, actualProcessKilled = killed, childGone, restartedRecovery = restarted,
        journalPhaseAtInterruption = phaseAtDeath, evidence, unrelatedPreserved = passed, sameTextReplacementObserved, scope = "NATIVE_JOURNAL_DELETE_NOT_VERIFIED_WORKER_PUBLICATION", txfUsed = false, projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
    }
    static readonly string[] RenameCheckpoints = { "before-rename", "intent", "renamed", "journal-renamed", "committed", "verified", "cleaned" };
    static Dictionary<string, object> RenameFixtureHeader(string project, string transactionId) {
      Dictionary<string, object> header = FixtureHeader(project, transactionId); header["version"] = 4;
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      op["sourcePath"] = "input.txt"; op["path"] = "renamed.txt"; op["kind"] = "RENAME";
      op["newDigest"] = op["baseDigest"];
      op["newBytes"] = Encoding.UTF8.GetByteCount("old-rename-complete");
      return header;
    }
    internal static int RenameFixtureChild(string point) {
      if (!RenameCheckpoints.Contains(point)) return 70;
      try {
        Dictionary<string, object> request = FixtureRequest(); string root = Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]);
        using (PublicationJournal journal = Begin(root, RenameFixtureHeader(root, (string)request["transactionId"]))) {
          journal.PublishSingleRename(delegate(string observed) {
            if (observed != point) return;
            Console.WriteLine(Serializer().Serialize(new { ready = true, checkpoint = point, phase = journal.last["phase"], transactionId = request["transactionId"] }));
            Console.Out.Flush(); Thread.Sleep(12000); throw new IOException("PHI_RENAME_KILL_FIXTURE_NOT_TERMINATED");
          });
        }
      } catch { Console.Error.WriteLine("PHI_RENAME_FIXTURE_CHILD_FAILED"); } return 70;
    }
    internal static int RenameFixtureRecover() {
      try {
        Dictionary<string, object> request = FixtureRequest();
        Console.WriteLine(Serializer().Serialize(Inspect((string)request["transactionId"], Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]), (string)request["rootIdentity"], true))); return 0;
      } catch { Console.Error.WriteLine("PHI_RENAME_FIXTURE_RECOVERY_FAILED"); return 70; }
    }
    internal static int RenameSelfTest(string name) {
      string[] controls = { "normal", "production-normal", "production-conflict", "source-missing", "source-content-changed", "source-replaced", "source-removed-before-mutation",
        "source-changed-before-mutation", "source-replaced-before-mutation", "destination-exists", "destination-after-intent",
        "unauthorized", "protected-source", "protected-destination", "cross-parent", "root-identity", "source-sharing", "unobserved-advance",
        "source-recreate-after-crash", "destination-replace-after-crash", "destination-missing-after-crash" };
      if (!controls.Contains(name) && !(name.StartsWith("crash-") && RenameCheckpoints.Contains(name.Substring(6)))) return 70;
      ScopeRecovery scope = null; PublicationJournal journal = null; Process child = null;
      string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN"; bool passed = false, clean = false, killed = false, childGone = false, restarted = false;
      object evidence = null, reconstructionReceipt = null; string phaseAtDeath = null, recoveryStatus = null, recoveryPhase = null, reconstructionDecision = null; int? recoveryExit = null;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready(); string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        string source = Path.Combine(scope.Root, "input.txt"), target = Path.Combine(scope.Root, "renamed.txt"), unrelated = Path.Combine(scope.Root, "unrelated.txt");
        File.WriteAllText(source, "old-rename-complete", new UTF8Encoding(false)); File.WriteAllText(unrelated, "unrelated-rename-user", new UTF8Encoding(false));
        bool crash = name.StartsWith("crash-") || name.EndsWith("after-crash");
        if (name == "production-normal" || name == "production-conflict") {
          Dictionary<string, object> header = RenameFixtureHeader(scope.Root, tx);
          foreach (string key in new string[] { "version", "creatorPid", "creatorGeneration" }) header.Remove(key);
          if (name == "production-conflict") File.WriteAllText(target, "new-rename-user", new UTF8Encoding(false));
          stage = "PRODUCTION_ENDPOINT";
          child = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-rename",
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
          child.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root, header, guardianPid = Process.GetCurrentProcess().Id, timeoutMs = 10000 })); child.StandardInput.Close();
          if (!child.WaitForExit(5000) || child.ExitCode != (name == "production-normal" ? 0 : 70)) throw new InvalidDataException(); childGone = child.HasExited;
          string output = child.StandardOutput.ReadToEnd(); if (output.Length > 16384) throw new InvalidDataException();
          Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(output); evidence = result;
          if ((string)result["status"] != (name == "production-normal" ? "PASS_NATIVE_SINGLE_RENAME" : "FAIL_NATIVE_SINGLE_RENAME") ||
              (bool)result["projectPublished"] || (int)result["externalRequests"] != 0) throw new InvalidDataException();
          if (name == "production-normal") {
            Dictionary<string, object> receipt = (Dictionary<string, object>)result["receipt"];
            Dictionary<string, object> metadata = (Dictionary<string, object>)receipt["journal"];
            if ((string)metadata["phase"] != "CLEANED" || File.Exists(source) || File.ReadAllText(target) != "old-rename-complete") throw new InvalidDataException();
          } else if ((string)result["reason"] != "CONFLICT" || result["journal"] != null ||
                     File.ReadAllText(source) != "old-rename-complete" || File.ReadAllText(target) != "new-rename-user") throw new InvalidDataException();
        } else if (crash) {
          string point = name.StartsWith("crash-") ? name.Substring(6) : "journal-renamed";
          child = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-rename-fixture-child " + point,
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
          child.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); child.StandardInput.Close();
          string ready = null; Thread reader = new Thread(delegate() { try { ready = child.StandardOutput.ReadLine(); } catch { } }); reader.IsBackground = true; reader.Start();
          if (!reader.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
          Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
          if (!(bool)announcement["ready"] || (string)announcement["checkpoint"] != point || (string)announcement["transactionId"] != tx) throw new InvalidDataException();
          phaseAtDeath = (string)announcement["phase"]; stage = "KILL";
          child.Kill(); killed = true; if (!child.WaitForExit(3000) || !child.HasExited || child.ExitCode == 0) throw new InvalidDataException(); childGone = true;
          bool old = point == "before-rename" || point == "intent";
          if (File.Exists(source) != old || File.Exists(target) == old || File.ReadAllText(old ? source : target) != "old-rename-complete") throw new InvalidDataException();
          if (name == "source-recreate-after-crash") File.WriteAllText(source, "new-rename-user", new UTF8Encoding(false));
          if (name == "destination-replace-after-crash") { File.Move(target, target + ".user-owned"); File.WriteAllText(target, "old-rename-complete", new UTF8Encoding(false)); }
          if (name == "destination-missing-after-crash") File.Move(target, target + ".user-owned");
          stage = "NEW_PROCESS_RECOVERY";
          using (Process recovery = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-rename-fixture-recover",
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
            try {
              recovery.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); recovery.StandardInput.Close();
              if (!recovery.WaitForExit(5000)) throw new InvalidDataException();
              recoveryExit = recovery.ExitCode; if (recoveryExit != 0) throw new InvalidDataException();
              string output = recovery.StandardOutput.ReadToEnd(); if (output.Length > 16384) throw new InvalidDataException();
              Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(output); evidence = result; restarted = true;
              recoveryStatus = result["status"] as string;
              string expectedStatus = name == "destination-missing-after-crash" ? "UNKNOWN_FAIL_SAFE" : name.EndsWith("after-crash") ? "CONFLICT" : old ? "OLD_COMPLETE_OBSERVED" : "RENAME_COMMITTED_DESTINATION_RETAINED";
              if ((string)result["status"] != expectedStatus || (bool)result["ownerGenerationAlive"] || (bool)result["projectPublished"] || (int)result["projectMutations"] != 0 || (int)result["processKills"] != 0) throw new InvalidDataException();
              Dictionary<string, object> metadata = (Dictionary<string, object>)result["metadata"];
              recoveryPhase = metadata["phase"] as string;
              string expectedPhase = name.EndsWith("after-crash") ? phaseAtDeath : old ? "ROLLED_BACK" : point == "cleaned" ? "CLEANED" : "RECOVERY_REQUIRED";
              if ((string)metadata["phase"] != expectedPhase || name.EndsWith("after-crash") && (int)result["journalMutations"] != 0) throw new InvalidDataException();
            } finally { if (!recovery.HasExited) { recovery.Kill(); recovery.WaitForExit(3000); } }
          }
          if (name == "crash-intent" || name == "crash-journal-renamed" || name == "source-recreate-after-crash") {
            // A *third* process uses only the owned root locator, transaction
            // ID, durable journal and actual filesystem, never fixture memory.
            stage = "NEW_CONTROLLER_READ_ONLY_RECONSTRUCTION";
            using (Process inspector = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
              Arguments = "--publication-inspect-known", UseShellExecute = false, RedirectStandardInput = true,
              RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
              try {
                inspector.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root, transactionId = tx })); inspector.StandardInput.Close();
                if (!inspector.WaitForExit(5000) || inspector.ExitCode != 0) throw new InvalidDataException();
                string output = inspector.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
                Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(output); reconstructionReceipt = result;
                reconstructionDecision = result["decision"] as string;
                string expected = name == "crash-intent" ? "ROLLBACK" : name == "source-recreate-after-crash" ? "CONFLICT" : "MANUAL_RECOVERY_REQUIRED";
                if ((string)result["status"] != "PASS_READ_ONLY_RECONSTRUCTION" || reconstructionDecision != expected ||
                    (string)result["transactionId"] != tx || (string)result["rootIdentity"] != rootId || !(bool)result["rootIdentityVerified"] ||
                    (string)result["phase"] != recoveryPhase || (bool)result["actionPerformed"] || (int)result["journalMutations"] != 0 ||
                    (int)result["projectMutations"] != 0 || (int)result["processKills"] != 0 || (bool)result["projectPublished"] ||
                    (int)result["externalRequests"] != 0) throw new InvalidDataException();
              } finally { if (!inspector.HasExited) { inspector.Kill(); inspector.WaitForExit(3000); } }
            }
            if (name == "crash-intent") {
              // A fabricated locator must not become a recovery decision.
              using (Process invalid = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
                Arguments = "--publication-inspect-known", UseShellExecute = false, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
                try {
                  invalid.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root, transactionId = Guid.NewGuid().ToString("N") })); invalid.StandardInput.Close();
                  if (!invalid.WaitForExit(5000) || invalid.ExitCode != 70) throw new InvalidDataException();
                  string rejected = invalid.StandardOutput.ReadToEnd(); if (rejected.Length > 1024) throw new InvalidDataException();
                  Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(rejected);
                  if ((string)result["status"] != "FAIL_READ_ONLY_RECONSTRUCTION" || (bool)result["projectPublished"] ||
                      (bool)result["actionPerformed"] || (int)result["projectMutations"] != 0 || (int)result["journalMutations"] != 0) throw new InvalidDataException();
                } finally { if (!invalid.HasExited) { invalid.Kill(); invalid.WaitForExit(3000); } }
              }
            }
          }
          if (name == "source-recreate-after-crash" && File.ReadAllText(source) != "new-rename-user") throw new InvalidDataException();
          if (old && (!File.Exists(source) || File.ReadAllText(source) != "old-rename-complete")) throw new InvalidDataException();
          if (File.Exists(target) != (!old && name != "destination-missing-after-crash")) throw new InvalidDataException();
        } else {
          Dictionary<string, object> header = RenameFixtureHeader(scope.Root, tx);
          Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
          if (name == "source-missing") File.Delete(source);
          if (name == "source-content-changed") File.WriteAllText(source, "new-rename-user", new UTF8Encoding(false));
          if (name == "source-replaced") { File.Move(source, source + ".user-owned"); File.WriteAllText(source, "old-rename-complete", new UTF8Encoding(false)); }
          if (name == "destination-exists") File.WriteAllText(target, "new-rename-user", new UTF8Encoding(false));
          if (name == "unauthorized") op["kind"] = "DELETE";
          if (name == "protected-source") op["sourcePath"] = ".env";
          if (name == "protected-destination") op["path"] = ".env";
          if (name == "cross-parent") op["path"] = "nested/renamed.txt";
          if (name == "root-identity") header["projectIdentity"] = new string('a', 16) + ":" + new string('b', 32);
          bool admission = new string[] { "source-missing", "source-content-changed", "source-replaced", "destination-exists", "unauthorized", "protected-source", "protected-destination", "cross-parent", "root-identity" }.Contains(name);
          if (admission) {
            bool denied = false; try { using (PublicationJournal rejected = Begin(scope.Root, header)) { } } catch (Exception error) { denied = error is AdmissionConflict || error is InvalidDataException; }
            if (!denied || File.Exists(target) != (name == "destination-exists")) throw new InvalidDataException();
            evidence = new { rejected = true, journalAbsent = true, mutationStarted = false };
          } else {
            journal = Begin(scope.Root, header);
            if (name == "unobserved-advance") {
              bool denied = false; try { journal.Advance("RENAME_INTENT", (string)op["baseIdentity"]); } catch (InvalidOperationException) { denied = true; }
              if (!denied || (string)journal.last["phase"] != "PREPARED") throw new InvalidDataException(); evidence = journal.Metadata("RETAINED");
            } else if (name == "source-sharing") {
              using (FileStream hold = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                bool denied = false; try { journal.PublishSingleRename(delegate(string p) { }); } catch (System.ComponentModel.Win32Exception error) { denied = error.NativeErrorCode == 32 || error.NativeErrorCode == 33; }
                if (!denied || !File.Exists(source) || File.Exists(target)) throw new InvalidDataException();
              }
              evidence = journal.Metadata("RETAINED");
            } else {
              bool failed = false;
              try { evidence = journal.PublishSingleRename(delegate(string p) {
                if (p == "before-rename" && name == "source-removed-before-mutation") File.Delete(source);
                if (p == "before-rename" && name == "source-changed-before-mutation") File.WriteAllText(source, "new-rename-user", new UTF8Encoding(false));
                if (p == "before-rename" && name == "source-replaced-before-mutation") {
                  using (RecoveryFilesystem user = new RecoveryFilesystem(scope.Root)) {
                    RecoveryFilesystem.Info info; IntPtr file = user.OpenDeleteSource("input.txt", out info);
                    try { user.QuarantineDeleteSource(file, "input.txt.user-owned"); } finally { CloseNative(file); }
                  }
                  File.WriteAllText(source, "old-rename-complete", new UTF8Encoding(false));
                }
                if (name == "destination-after-intent" && p == "intent") File.WriteAllText(target, "new-rename-user", new UTF8Encoding(false));
              }); } catch (InvalidOperationException error) { if (error.Message != "PHI_PUBLICATION_CONFLICT") throw; failed = true; }
              if (failed != (name != "normal") || File.Exists(source) != (failed && name != "source-removed-before-mutation") ||
                  File.Exists(target) != (name == "normal" || name == "destination-after-intent")) throw new InvalidDataException();
              if (name == "normal" && File.ReadAllText(target) != "old-rename-complete" || name == "destination-after-intent" && File.ReadAllText(target) != "new-rename-user") throw new InvalidDataException();
              if (name != "normal" && (string)journal.last["phase"] != "CONFLICT") throw new InvalidDataException();
              if (name == "source-replaced-before-mutation") {
                using (RecoveryFilesystem observer = new RecoveryFilesystem(scope.Root)) {
                  DeleteObject replacement = ReadDeleteLeaf(observer, "input.txt"), original = ReadDeleteLeaf(observer, "input.txt.user-owned");
                  if (replacement == null || original == null || replacement.Identity == (string)op["baseIdentity"] ||
                      !DeleteBaseMatches(original, op) || replacement.Digest != (string)op["baseDigest"]) throw new InvalidDataException();
                }
              }
            }
          }
        }
        if (File.ReadAllText(unrelated) != "unrelated-rename-user") throw new InvalidDataException(); passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_RENAME_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8") +
        ":recoveryExit=" + (recoveryExit.HasValue ? recoveryExit.Value.ToString() : "none") + ":status=" + (recoveryStatus ?? "none") + ":phase=" + (recoveryPhase ?? "none")); }
      finally {
        if (journal != null) journal.Dispose();
        if (child != null) { try { if (!child.HasExited) { child.Kill(); child.WaitForExit(3000); } } finally { child.Dispose(); } }
        try {
          using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean, actualProcessKilled = killed, childGone,
        restartedRecovery = restarted, reconstructionDecision, reconstructionReceipt, journalPhaseAtInterruption = phaseAtDeath, evidence, unrelatedPreserved = passed,
        scope = "NATIVE_JOURNAL_RENAME_NOT_VERIFIED_WORKER_PUBLICATION", txfUsed = false, projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
    }
    internal static int ModifyFixtureChild(string phase) {
      if (!ModifyCheckpoints.Contains(phase) || phase == "before-transaction") return 70;
      try {
        Dictionary<string, object> request = FixtureRequest();
        string root = Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]);
        Dictionary<string, object> header = FixtureHeader(root, (string)request["transactionId"]); header["version"] = 2;
        using (PublicationJournal journal = Begin(root, header)) {
          journal.PublishSingleModify(Encoding.UTF8.GetBytes("new-complete"), delegate(string observed) {
            if (observed != phase) return;
            Console.WriteLine(Serializer().Serialize(new { ready = true, checkpoint = observed, phase = journal.last["phase"], transactionId = request["transactionId"], tempIdentity = journal.last["tempIdentity"] }));
            Console.Out.Flush(); Thread.Sleep(12000); throw new IOException("PHI_MODIFY_KILL_FIXTURE_NOT_TERMINATED");
          });
        }
      } catch { Console.Error.WriteLine("PHI_MODIFY_FIXTURE_CHILD_FAILED"); }
      return 70;
    }
    internal static int ModifyFixtureRecover() {
      try {
        Dictionary<string, object> request = FixtureRequest();
        Console.WriteLine(Serializer().Serialize(Inspect((string)request["transactionId"], Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]), (string)request["rootIdentity"], true))); return 0;
      } catch { Console.Error.WriteLine("PHI_MODIFY_FIXTURE_RECOVERY_FAILED"); return 70; }
    }
    static readonly string[] AdmissionCases = { "admission-content-change", "admission-recreated", "admission-missing", "admission-root-mismatch", "admission-invalid-header", "admission-sharing" };
    static int AdmissionSelfTest(string name) {
      // Reproduce the exact pre-Begin boundary through the production endpoint,
      // not an injected exception or a configurable production checkpoint.
      ScopeRecovery scope = null; FileStream held = null; Process child = null;
      string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN"; object evidence = null;
      int? publisherPid = null, publisherExitCode = null;
      bool passed = false, clean = false, childGone = false, journalAbsent = false, tempAbsent = false, ownedKey = false;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        string target = Path.Combine(scope.Root, "input.txt"), unrelated = Path.Combine(scope.Root, "sentinel.txt");
        File.WriteAllText(target, "old-complete", new UTF8Encoding(false)); File.WriteAllText(unrelated, "unrelated-user", new UTF8Encoding(false));
        Dictionary<string, object> header = FixtureHeader(scope.Root, tx);
        foreach (string key in new string[] { "version", "creatorPid", "creatorGeneration" }) header.Remove(key);
        // The original snapshot/request exists before this real user mutation.
        if (name == "admission-content-change") File.WriteAllText(target, "user-complete", new UTF8Encoding(false));
        else if (name == "admission-recreated") { File.Move(target, target + ".old"); File.WriteAllText(target, "old-complete", new UTF8Encoding(false)); }
        else if (name == "admission-missing") File.Delete(target);
        else if (name == "admission-root-mismatch") header["projectIdentity"] = new string('a', 16) + ":" + new string('b', 32);
        else if (name == "admission-invalid-header") header["unexpected"] = "FORBIDDEN_RAW_SENTINEL";
        else if (name == "admission-sharing") held = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.None);
        stage = "PRODUCTION_ENDPOINT";
        child = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-modify", UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        publisherPid = child.Id;
        child.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root, header, content = "new-complete", guardianPid = Process.GetCurrentProcess().Id, timeoutMs = 10000 })); child.StandardInput.Close();
        if (!child.WaitForExit(5000) || child.ExitCode != 70) throw new InvalidDataException(); childGone = child.HasExited; publisherExitCode = child.ExitCode;
        string output = child.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
        Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(output); evidence = result;
        bool conflict = name == "admission-content-change" || name == "admission-recreated" || name == "admission-missing";
        if ((string)result["status"] != "FAIL_NATIVE_SINGLE_MODIFY" || (string)result["reason"] != (conflict ? "CONFLICT" : "UNCONFIRMED") || result["journal"] != null ||
            (bool)result["projectPublished"] || (int)result["externalRequests"] != 0) throw new InvalidDataException();
        if (conflict) {
          Dictionary<string, object> admission = result["admission"] as Dictionary<string, object>;
          if (admission == null || (string)result["phase"] != "ADMISSION" || (string)admission["scope"] != "VALIDATED_BASE_CONFLICT_BEFORE_JOURNAL" ||
              (string)admission["phase"] != "ADMISSION_CONFLICT" || (bool)admission["journalCreated"] || (bool)admission["mutationStarted"] ||
              (bool)admission["projectPublished"] || (string)admission["commitState"] != "NOT_STARTED" || (int)admission["pendingOperations"] != 1 ||
              ((IList)admission["filesCommitted"]).Count != 0 || header.Any(pair => Serializer().Serialize(pair.Value) != Serializer().Serialize(admission[pair.Key]))) throw new InvalidDataException();
        } else if (result["admission"] != null) throw new InvalidDataException();
        if (held != null) { held.Dispose(); held = null; }
        using (RegistryKey root = Registry.CurrentUser.OpenSubKey(RegistryBase, false)) {
          if (root == null) journalAbsent = true;
          else { ScopeRecovery.ValidateRegistry(root); using (RegistryKey key = root.OpenSubKey(tx, false)) { journalAbsent = key == null; ownedKey = key != null; } }
        }
        tempAbsent = Directory.GetFiles(scope.Root, "phi-publish-*.tmp", SearchOption.AllDirectories).Length == 0;
        if (!journalAbsent || !tempAbsent || File.ReadAllText(unrelated) != "unrelated-user" ||
            (name == "admission-missing" ? File.Exists(target) : File.ReadAllText(target) != (name == "admission-content-change" ? "user-complete" : "old-complete"))) throw new InvalidDataException();
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_ADMISSION_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8")); }
      finally {
        if (held != null) held.Dispose();
        if (child != null) { try { if (!child.HasExited) { child.Kill(); child.WaitForExit(3000); } childGone = child.HasExited; } catch { passed = false; } child.Dispose(); }
        try {
          if (ownedKey) using (RegistryKey root = OpenBase(true)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean, childGone, publisherPid, publisherExitCode, journalAbsent, tempAbsent,
        userStatePreserved = passed, evidence, scope = "NATIVE_PREJOURNAL_ADMISSION", projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
    }
    internal static int ModifySelfTest(string name) {
      if (AdmissionCases.Contains(name)) return AdmissionSelfTest(name);
      bool crash = name.StartsWith("crash-", StringComparison.Ordinal), userConflict = name == "user-content-after-crash" || name == "same-content-recreated-after-crash" || name == "user-delete-after-crash";
      string point = crash ? name.Substring(6) : userConflict ? "before-journal-committed" : name;
      if (name != "commit" && name != "unobserved-advance" && name != "concurrent-change-at-ready" && !userConflict && !ModifyCheckpoints.Contains(point)) return 70;
      if (crash && point == "before-transaction") return 70;
      ScopeRecovery scope = null; PublicationJournal journal = null; Process child = null;
      string tx = Guid.NewGuid().ToString("N"), rootId = null, stage = "BEGIN";
      bool passed = false, clean = false, created = false, injected = false, killed = false, childGone = false, restarted = false, tempAbsent = false;
      object evidence = null; string journalPhase = null;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready(); rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        string target = Path.Combine(scope.Root, "input.txt"), unrelated = Path.Combine(scope.Root, "sentinel.txt");
        File.WriteAllText(target, "old-complete", new UTF8Encoding(false)); File.WriteAllText(unrelated, "unrelated-user", new UTF8Encoding(false));
        if (crash || userConflict) {
          stage = "CHILD_START";
          child = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-modify-fixture-child " + point, UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
          child.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); child.StandardInput.Close();
          string ready = null; Thread reader = new Thread(delegate() { try { ready = child.StandardOutput.ReadLine(); } catch { } }); reader.IsBackground = true; reader.Start();
          if (!reader.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
          Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
          if (!(bool)announcement["ready"] || (string)announcement["checkpoint"] != point || (string)announcement["transactionId"] != tx || announcement["tempIdentity"] == null) throw new InvalidDataException();
          journalPhase = (string)announcement["phase"]; created = true; stage = "KILL";
          child.Kill(); killed = true; if (!child.WaitForExit(3000) || !child.HasExited || child.ExitCode == 0) throw new InvalidDataException(); childGone = true;
          bool expectedNew = new string[] { "before-journal-committed", "committed", "postverify", "cleanup" }.Contains(point);
          if (File.ReadAllText(target) != (expectedNew ? "new-complete" : "old-complete")) throw new InvalidDataException();
          if (name == "user-content-after-crash") File.WriteAllText(target, "user-complete", new UTF8Encoding(false));
          if (name == "same-content-recreated-after-crash") { File.Move(target, target + ".old"); File.WriteAllText(target, "new-complete", new UTF8Encoding(false)); }
          if (name == "user-delete-after-crash") File.Delete(target);
          stage = "RESTART_RECOVERY";
          using (Process recovery = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-modify-fixture-recover", UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
            try {
              recovery.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); recovery.StandardInput.Close();
              if (!recovery.WaitForExit(5000) || recovery.ExitCode != 0) throw new InvalidDataException();
              string output = recovery.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
              Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(output); evidence = result; restarted = true;
              if ((string)result["status"] != (userConflict ? "CONFLICT" : expectedNew ? "NEW_COMPLETE_OBSERVED" : "OLD_COMPLETE_OBSERVED") ||
                  (bool)result["ownerGenerationAlive"] || (bool)result["projectPublished"] || (int)result["projectMutations"] != 0 || (int)result["processKills"] != 0) throw new InvalidDataException();
              Dictionary<string, object> metadata = (Dictionary<string, object>)result["metadata"];
              if (!userConflict && (string)metadata["phase"] != (expectedNew ? point == "cleanup" ? "CLEANED" : "RECOVERY_REQUIRED" : "ROLLED_BACK")) throw new InvalidDataException();
              if (userConflict && ((int)result["journalMutations"] != 0 || (string)metadata["phase"] != journalPhase)) throw new InvalidDataException();
            } finally { if (!recovery.HasExited) { recovery.Kill(); recovery.WaitForExit(3000); } }
          }
          string after = name == "user-content-after-crash" ? "user-complete" : expectedNew ? "new-complete" : "old-complete";
          if (name == "user-delete-after-crash" ? File.Exists(target) : File.ReadAllText(target) != after) throw new InvalidDataException();
        } else {
          Dictionary<string, object> header = FixtureHeader(scope.Root, tx); header["version"] = 2;
          journal = Begin(scope.Root, header); created = true;
          if (name == "unobserved-advance") {
            bool denied = false; try { journal.Advance("TEMP_CREATED", rootId); } catch (InvalidOperationException) { denied = true; }
            if (!denied || (string)journal.last["phase"] != "PREPARED" || File.ReadAllText(target) != "old-complete") throw new InvalidDataException();
          } else if (name == "concurrent-change-at-ready") {
            bool conflict = false;
            try { journal.PublishSingleModify(Encoding.UTF8.GetBytes("new-complete"), delegate(string observed) { if (observed == "validation") File.WriteAllText(target, "user-complete", new UTF8Encoding(false)); }); }
            catch (InvalidOperationException error) { if (error.Message != "PHI_PUBLICATION_CONFLICT") throw; conflict = true; }
            if (!conflict || (string)journal.last["phase"] != "CONFLICT" || File.ReadAllText(target) != "user-complete") throw new InvalidDataException();
          } else {
            try { evidence = journal.PublishSingleModify(Encoding.UTF8.GetBytes("new-complete"), delegate(string observed) { if (observed == name) { injected = true; throw new IOException("PHI_MODIFY_JOURNAL_INJECTED"); } }); }
            catch (IOException) { if (!injected) throw; }
            bool expectedNew = name == "commit" || new string[] { "before-journal-committed", "committed", "postverify", "cleanup" }.Contains(name);
            if (injected != (name != "commit") || File.ReadAllText(target) != (expectedNew ? "new-complete" : "old-complete")) throw new InvalidDataException();
            if (name == "commit" && (string)journal.last["phase"] != "CLEANED") throw new InvalidDataException();
          }
          journalPhase = (string)journal.last["phase"]; if (evidence == null) evidence = journal.Metadata("RETAINED");
        }
        tempAbsent = Directory.GetFiles(scope.Root, "phi-publish-*.tmp", SearchOption.AllDirectories).Length == 0;
        if (!tempAbsent || File.ReadAllText(unrelated) != "unrelated-user") throw new InvalidDataException(); passed = true;
      } catch (Exception error) {
        Console.Error.WriteLine("PHI_MODIFY_JOURNAL_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8"));
        if (child != null && child.HasExited) { string detail = child.StandardError.ReadToEnd(); if (detail.Length <= 8192) Console.Error.Write(detail); }
      } finally {
        if (journal != null) journal.Dispose();
        if (child != null) { try { if (!child.HasExited) { child.Kill(); child.WaitForExit(3000); } } finally { child.Dispose(); } }
        try {
          // Only the original fixed fixture owner removes its own exact key.
          // Production recovery never deletes any journal/project/temp object.
          if (created) using (RegistryKey root = OpenBase(true)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean, injected, actualProcessKilled = killed, childGone, restartedRecovery = restarted,
        tempAbsent, journalPhaseAtInterruption = journalPhase, unrelatedPreserved = passed, evidence, scope = "NATIVE_JOURNAL_MODIFY_NOT_VERIFIED_WORKER_PUBLICATION", projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
    }
    internal static int SelfTest(string name) {
      string[] cases = { "metadata", "transition", "duplicate", "active", "corrupt", "gap", "oversized", "unknown-owner", "unsafe-acl", "project-replaced", "user-change", "same-content-replaced", "protected", "crash-prepared", "crash-written", "crash-flushed", "crash-ready", "crash-commit-started" };
      if (!cases.Contains(name)) return 70;
      ScopeRecovery scope = null; PublicationJournal journal = null; Process child = null; string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN"; bool created = false, passed = false, killed = false, childGone = false, restarted = false, pinnedRenameDenied = false, clean = false; object evidence = null;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        File.WriteAllText(Path.Combine(scope.Root, "input.txt"), "old-complete", new UTF8Encoding(false));
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        Dictionary<string, object> header = FixtureHeader(scope.Root, tx);
        if (name.StartsWith("crash-", StringComparison.Ordinal) || name == "same-content-replaced") {
          stage = "CHILD_START";
          string phase = name == "crash-prepared" || name == "same-content-replaced" ? "PREPARED" : name == "crash-written" ? "TEMP_WRITTEN" : name == "crash-flushed" ? "TEMP_FLUSHED" : name == "crash-ready" ? "READY_TO_COMMIT" : "COMMIT_STARTED";
          child = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-journal-fixture-child " + phase, UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
          child.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); child.StandardInput.Close();
          string ready = null; Thread reader = new Thread(delegate() { try { ready = child.StandardOutput.ReadLine(); } catch { } }); reader.IsBackground = true; reader.Start();
          if (!reader.Join(7000) || ready == null) throw new InvalidDataException();
          Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
          if (!(bool)announcement["ready"] || (string)announcement["phase"] != phase || (string)announcement["transactionId"] != tx) throw new InvalidDataException();
          created = true;
          if (name == "same-content-replaced") {
            stage = "PINNED_USER_RENAME";
            try { File.Move(Path.Combine(scope.Root, "input.txt"), Path.Combine(scope.Root, "previous.txt")); }
            catch (IOException error) { if (unchecked((uint)Marshal.GetHRForException(error)) != 0x80070020U) throw; pinnedRenameDenied = true; }
            if (!pinnedRenameDenied || File.ReadAllText(Path.Combine(scope.Root, "input.txt")) != "old-complete") throw new InvalidDataException();
          }
          stage = "KILL";
          child.Kill(); killed = true; if (!child.WaitForExit(3000) || !child.HasExited || child.ExitCode == 0) throw new InvalidDataException(); childGone = true;
          if (name == "same-content-replaced") {
            // The producer is actually dead. Its kernel pins are gone, not
            // deliberately weakened/released by a live publication backend.
            stage = "USER_RENAME_AFTER_CRASH"; File.Move(Path.Combine(scope.Root, "input.txt"), Path.Combine(scope.Root, "previous.txt"));
            stage = "USER_RECREATE_AFTER_CRASH"; File.WriteAllText(Path.Combine(scope.Root, "input.txt"), "old-complete", new UTF8Encoding(false));
          }
          // Restart in a fresh native process after real TerminateProcess.
          stage = "RESTART_INSPECTION";
          using (Process inspector = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-journal-fixture-inspect", UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
            try {
              inspector.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); inspector.StandardInput.Close();
              if (!inspector.WaitForExit(3000) || inspector.ExitCode != 0) throw new InvalidDataException();
              string output = inspector.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
              evidence = Serializer().Deserialize<Dictionary<string, object>>(output); restarted = true;
            } finally { if (!inspector.HasExited) { inspector.Kill(); inspector.WaitForExit(3000); } }
          }
          Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(evidence));
          Dictionary<string, object> metadata = (Dictionary<string, object>)result["metadata"];
          if ((string)result["status"] != (name == "same-content-replaced" ? "CONFLICT" : "RECOVERY_REQUIRED") || (bool)result["baseMatches"] != (name != "same-content-replaced") ||
              (string)metadata["phase"] != phase || (bool)result["projectPublished"] || (int)result["projectMutations"] != 0) throw new InvalidDataException();
        } else if (name == "protected") {
          ((Dictionary<string, object>)((object[])header["operations"])[0])["path"] = ".env";
          bool denied = false; try { journal = Begin(scope.Root, header); } catch (InvalidDataException) { denied = true; }
          if (!denied) throw new InvalidDataException();
        } else {
          journal = Begin(scope.Root, header); created = true;
          if (name == "transition") {
            bool denied = false; try { journal.Advance("COMMITTED", null); } catch (InvalidDataException) { denied = true; }
            if (!denied) throw new InvalidDataException();
            foreach (string phase in new string[] { "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED" }) journal.Advance(phase, null);
            denied = false; try { journal.Advance("COMMITTED", null); } catch (InvalidOperationException) { denied = true; }
            if (!denied) throw new InvalidDataException();
            journal.Advance("RECOVERY_REQUIRED", null);
            denied = false; try { journal.Advance("CLEANED", null); } catch (InvalidDataException) { denied = true; }
            if (!denied) throw new InvalidDataException(); evidence = journal.Metadata("NOT_STARTED");
          } else if (name == "duplicate") {
            bool denied = false; try { using (PublicationJournal other = Begin(scope.Root, header)) { } } catch (InvalidDataException) { denied = true; }
            if (!denied) throw new InvalidDataException(); evidence = journal.Metadata("NOT_STARTED");
          } else if (name == "active") {
            evidence = Inspect(tx, scope.Root, rootId);
            if (!Serializer().Serialize(evidence).Contains("\"status\":\"ACTIVE\"")) throw new InvalidDataException();
          } else if (new string[] { "corrupt", "gap", "oversized", "unknown-owner", "unsafe-acl" }.Contains(name)) {
            journal.Dispose(); journal = null;
            using (RegistryKey root = OpenBase(true)) using (RegistryKey key = root.OpenSubKey(tx, true)) {
              byte[] bytes = ReadValue(key, "E00000000");
              if (name == "corrupt") bytes[8] ^= 1;
              else if (name == "oversized") bytes = new byte[MaxBytes + 1];
              else if (name == "unknown-owner") {
                Dictionary<string, object> body = Decode(bytes), value = (Dictionary<string, object>)body["header"]; value["unexpected"] = "FORBIDDEN_RAW_SENTINEL"; bytes = Envelope(body);
              }
              if (name == "unsafe-acl") {
                RegistrySecurity acl = ScopeRecovery.PrivateRegistryAcl(); acl.AddAccessRule(new RegistryAccessRule(new SecurityIdentifier(WellKnownSidType.WorldSid, null), RegistryRights.ReadKey, AccessControlType.Allow)); key.SetAccessControl(acl);
              } else if (name == "gap") key.SetValue("E00000002", bytes, RegistryValueKind.Binary); else key.SetValue("E00000000", bytes, RegistryValueKind.Binary);
              if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
            }
            bool denied = false; try { Inspect(tx, scope.Root, rootId); } catch (InvalidDataException) { denied = true; }
            if (!denied) throw new InvalidDataException(); evidence = new { status = "OWNERSHIP_OR_INTEGRITY_REJECTED", projectMutations = 0, journalMutations = 0 };
          } else if (name == "project-replaced") {
            bool denied = false; try { Inspect(tx, scope.Root, new string('a', 16) + ":" + new string('b', 32)); } catch (InvalidDataException) { denied = true; }
            if (!denied) throw new InvalidDataException(); evidence = new { status = "PROJECT_IDENTITY_REJECTED", projectMutations = 0 };
          } else if (name == "user-change") {
            File.WriteAllText(Path.Combine(scope.Root, "input.txt"), "user-complete", new UTF8Encoding(false));
            stage = "USER_BASE_CHECK";
            if (MatchesBase(scope.Root, journal.header)) throw new InvalidDataException();
            journal.Advance("TEMP_WRITTEN", null); journal.Advance("TEMP_FLUSHED", null);
            bool denied = false; try { journal.Advance("READY_TO_COMMIT", null); } catch (InvalidOperationException error) { denied = error.Message == "PHI_PUBLICATION_CONFLICT"; }
            if (!denied || (string)journal.last["phase"] != "CONFLICT") throw new InvalidDataException(); evidence = journal.Metadata("CONFLICT");
          } else evidence = journal.Metadata("NOT_STARTED");
          if (journal != null) using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx)) {
            string text = Serializer().Serialize(Decode(ReadValue(key, "E00000000")));
            if (text.Contains("old-complete") || text.Contains("new-complete") || text.Contains(scope.Root) || text.Contains("FORBIDDEN_RAW_SENTINEL")) throw new InvalidDataException();
          }
        }
        string expected = name == "user-change" ? "user-complete" : "old-complete";
        if (File.ReadAllText(Path.Combine(scope.Root, "input.txt")) != expected) throw new InvalidDataException(); passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_PUBLICATION_JOURNAL_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8")); }
      finally {
        if (child != null) { try { if (!child.HasExited) { child.Kill(); child.WaitForExit(3000); } childGone = child.HasExited; } catch { passed = false; } child.Dispose(); }
        if (journal != null) journal.Dispose();
        // Deliberately corrupt/unknown records are removed ONLY by this fixture
        // owner, not by Inspect/recovery. Production preserves such evidence.
        if (created) try { using (RegistryKey root = OpenBase(true)) { root.DeleteSubKeyTree(tx, false); if (RegFlushKey(root.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException(); } } catch { passed = false; }
        if (scope != null) { try { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); } catch { passed = false; } scope.Complete(clean); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, scope = "DURABLE_JOURNAL_ONLY_NOT_PUBLICATION_CRASH_RECOVERY", evidence, actualProcessKilled = killed, childGone, restartedInspector = restarted, pinnedRenameDenied, fixtureCleanup = clean, externalRequests = 0, projectPublished = false }));
      return passed && clean ? 0 : 70;
    }
  }
}
