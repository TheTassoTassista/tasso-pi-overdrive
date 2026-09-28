// Trusted durable publication journal, never a model endpoint. V1 metadata
// only; V2 single-file MODIFY uses the internal native transaction primitive.
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
    internal static readonly string[] Phases = { "PREPARED", "TEMP_CREATED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "COMMITTED", "VERIFIED", "POST_COMMIT_VERIFIED", "CLEANED", "CONFLICT", "ROLLBACK_REQUIRED", "ROLLED_BACK", "RECOVERY_REQUIRED", "FAILED" };
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
    bool acquired, poisoned, disposed;
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
      int version = Number(value, "version", 1, 2); if (StringField(value, "transactionId", Id) != transactionId) throw new InvalidDataException();
      StringField(value, "projectIdentity", Identity); StringField(value, "draftId", Id); Number(value, "draftVersion", 0, Int32.MaxValue);
      StringField(value, "verifiedDigest", Digest); StringField(value, "baseDigest", Digest); Number(value, "creatorPid", 1, Int32.MaxValue);
      StringField(value, "creatorGeneration", new Regex("\\A[0-9a-f]{16}\\z"));
      HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase), ids = new HashSet<string>(StringComparer.Ordinal);
      foreach (object entry in Operations(value)) {
        Dictionary<string, object> op = entry as Dictionary<string, object>;
        Keys(op, "path", "kind", "baseIdentity", "baseDigest", "newDigest", "newBytes");
        string relative = op["path"] as string; AnchoredFile.Segments(relative);
        if (relative.Length > 240 || !Regex.IsMatch(relative, "\\A[A-Za-z0-9_./-]+\\z") || !names.Add(relative)) throw new InvalidDataException();
        string kind = op["kind"] as string; if (kind != "CREATE" && kind != "REPLACE" && kind != "DELETE") throw new InvalidDataException();
        if (kind == "CREATE") { if (op["baseIdentity"] != null || op["baseDigest"] != null) throw new InvalidDataException(); }
        else { if (!ids.Add(StringField(op, "baseIdentity", Identity))) throw new InvalidDataException(); StringField(op, "baseDigest", Digest); }
        if (kind == "DELETE") { if (op["newDigest"] != null || op["newBytes"] != null) throw new InvalidDataException(); }
        else { StringField(op, "newDigest", Digest); Number(op, "newBytes", 0, 1024 * 1024); }
        if (version == 2 && (Operations(value).Count != 1 || kind != "REPLACE" || Object.Equals(op["baseDigest"], op["newDigest"]))) throw new InvalidDataException();
      }
    }
    static bool Transition(string from, string to, int previousOp, int nextOp, int count, int version) {
      if (!Phases.Contains(to) || from == "CLEANED" || from == "ROLLED_BACK" || from == "FAILED" || from == "CONFLICT") return false;
      if (to == "CONFLICT" || to == "FAILED" || to == "RECOVERY_REQUIRED" || to == "ROLLBACK_REQUIRED") return previousOp == nextOp;
      if (from == "ROLLBACK_REQUIRED") return to == "ROLLED_BACK" && previousOp == nextOp;
      if (from == "RECOVERY_REQUIRED") return false; // needs a separately proven recovery adapter, not a guessed phase
      if (from == "VERIFIED" && to == "TEMP_WRITTEN") return nextOp == previousOp + 1 && nextOp < count;
      if (previousOp != nextOp) return false;
      string[] normal = version == 2 ? new string[] { "PREPARED", "TEMP_CREATED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }
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
        if ((string)op["kind"] == "CREATE") { if (files.ContainsKey(name)) return false; }
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
          if ((int)value["version"] == 2) throw new AdmissionConflict(value);
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
      if (((int)header["version"] == 2 && phase != "PREPARED" && !nativeObservation) ||
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
    }
    internal void Advance(string phase, string tempIdentity) {
      if ((int)header["version"] == 2) throw new InvalidOperationException("PHI_PUBLICATION_NATIVE_OBSERVATION_REQUIRED");
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
      if ((int)header["version"] != 2) throw new InvalidDataException();
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
    void ReadChain(RegistryKey key) {
      ScopeRecovery.ValidateRegistry(key);
      if (key.GetSubKeyNames().Length != 0) throw new InvalidDataException();
      string[] names = key.GetValueNames().OrderBy(x => x, StringComparer.Ordinal).ToArray();
      if (names.Length < 1 || names.Length > MaxEvents) throw new InvalidDataException();
      string previous = new string('0', 64); Dictionary<string, object> prior = null, original = null;
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
        previous = Hash(bytes); prior = body;
      }
      if (lastDigest != null && previous != lastDigest) throw new InvalidDataException();
      header = original; last = prior; lastDigest = previous;
    }
    internal object Metadata(string recovery) {
      if ((int)header["version"] == 2) return new { version = 2, scope = "SINGLE_FILE_MODIFY_JOURNAL_NOT_CONTROLLER_PUBLICATION", transactionId = id,
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
              if (recover) throw new InvalidDataException();
              bool unchanged = MatchesBase(project, parsed.header);
              return new { status = unchanged ? "RECOVERY_REQUIRED" : "CONFLICT", metadata = parsed.Metadata(unchanged ? "RECOVERY_REQUIRED" : "CONFLICT"), ownerGenerationAlive = false, baseMatches = unchanged,
                projectMutations = 0, journalMutations = 0, processKills = 0, projectPublished = false };
            }
          }
        } finally { mutex.ReleaseMutex(); }
      }
    }
    public void Dispose() {
      if (disposed) return; disposed = true;
      if (pins != null) pins.Dispose();
      if (lease != null) { if (acquired) { acquired = false; lease.ReleaseMutex(); } lease.Dispose(); }
    }

    // Fixed fixtures only. No arbitrary project/transaction or write endpoint.
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
