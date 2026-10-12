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
    internal static readonly string[] Phases = { "PREPARED", "TEMP_CREATED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "DELETE_INTENT", "DELETE_QUARANTINED", "RENAME_INTENT", "RENAMED", "MUTATION_STARTED", "COMMITTED", "VERIFIED", "POST_COMMIT_VERIFIED", "FINALIZED", "CLEANUP_STARTED", "CLEANED", "CONFLICT", "MANUAL_RECOVERY_REQUIRED", "ROLLBACK_REQUIRED", "ROLLED_BACK", "RECOVERY_REQUIRED", "FAILED" };
    static readonly Regex Id = new Regex("\\A[0-9a-f]{32}\\z", RegexOptions.CultureInvariant);
    static readonly Regex Identity = new Regex("\\A[0-9a-f]{16}:[0-9a-f]{32}\\z", RegexOptions.CultureInvariant);
    static readonly Regex Digest = new Regex("\\A[0-9a-f]{64}\\z", RegexOptions.CultureInvariant);
    const string RecoveryTerminalObservation = "RECOVERY_NATIVE_TERMINAL_OBSERVED";
    [DllImport("advapi32.dll")] static extern int RegFlushKey(IntPtr key);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] static extern int RegDeleteKeyW(IntPtr key, string name);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegQueryValueExW(IntPtr key, string name, IntPtr reserved, out uint type, byte[] bytes, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
    readonly string id, project;
    readonly Mutex lease;
    readonly RecoveryFilesystem pins;
    Dictionary<string, object> header, last, reclamation;
    string lastDigest;
    bool acquired, poisoned, disposed, deleteCleanupIntent, recoveryMutationUncertain, recoveryJournalAppendAttempted;
    Action fixtureAfterRecoveryTerminalSetValue;
    string[] mixedPhases, mixedTempIdentities, mixedCommittedIdentities;
    int recoveryProjectMutations;
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
      int version = Number(value, "version", 1, 6); if (StringField(value, "transactionId", Id) != transactionId) throw new InvalidDataException();
      StringField(value, "projectIdentity", Identity); StringField(value, "draftId", Id); Number(value, "draftVersion", 0, Int32.MaxValue);
      StringField(value, "verifiedDigest", Digest); StringField(value, "baseDigest", Digest); Number(value, "creatorPid", 1, Int32.MaxValue);
      StringField(value, "creatorGeneration", new Regex("\\A[0-9a-f]{16}\\z"));
      HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase), ids = new HashSet<string>(StringComparer.Ordinal);
      IList operations = Operations(value);
      if (version == 5 && (operations.Count != 4 ||
          !operations.Cast<object>().Select(item => (item as Dictionary<string, object>) == null ? null : ((Dictionary<string, object>)item)["kind"] as string)
            .SequenceEqual(new string[] { "REPLACE", "CREATE", "DELETE", "RENAME" }))) throw new InvalidDataException();
      // V6 is single CREATE only. V5's unprofiled four-operation meaning is
      // immutable, including its rejection of every shorter manifest.
      if (version == 6 && (operations.Count != 1 || !(operations[0] is Dictionary<string, object>) ||
          (string)((Dictionary<string, object>)operations[0])["kind"] != "CREATE")) throw new InvalidDataException();
      foreach (object entry in operations) {
        Dictionary<string, object> op = entry as Dictionary<string, object>;
        if ((version == 4 || version == 5) && op != null && (op["kind"] as string) == "RENAME") Keys(op, "sourcePath", "path", "kind", "baseIdentity", "baseDigest", "newDigest", "newBytes");
        else Keys(op, "path", "kind", "baseIdentity", "baseDigest", "newDigest", "newBytes");
        string relative = op["path"] as string; AnchoredFile.Segments(relative);
        if (relative.Length > 240 || !Regex.IsMatch(relative, "\\A[A-Za-z0-9_./-]+\\z") || !names.Add(relative)) throw new InvalidDataException();
        string kind = op["kind"] as string; if (kind != "CREATE" && kind != "REPLACE" && kind != "DELETE" && kind != "RENAME") throw new InvalidDataException();
        if (kind == "RENAME" && version != 4 && version != 5) throw new InvalidDataException();
        if (kind == "CREATE") { if (op["baseIdentity"] != null || op["baseDigest"] != null) throw new InvalidDataException(); }
        else { if (!ids.Add(StringField(op, "baseIdentity", Identity))) throw new InvalidDataException(); StringField(op, "baseDigest", Digest); }
        if (kind == "DELETE") { if (op["newDigest"] != null || op["newBytes"] != null) throw new InvalidDataException(); }
        else { StringField(op, "newDigest", Digest); Number(op, "newBytes", 0, 1024 * 1024); }
        if (version == 2 && (Operations(value).Count != 1 || kind != "REPLACE" || Object.Equals(op["baseDigest"], op["newDigest"]))) throw new InvalidDataException();
        if (version == 3 && (Operations(value).Count != 1 || kind != "DELETE" || relative.Split('/').Last() == DeleteLeaf(transactionId))) throw new InvalidDataException();
        if (version == 5 && (kind == "REPLACE" && Object.Equals(op["baseDigest"], op["newDigest"]) ||
            kind == "DELETE" && relative.Split('/').Last() == DeleteLeaf(transactionId))) throw new InvalidDataException();
        if (version == 4 || version == 5 && kind == "RENAME") {
          string source = op["sourcePath"] as string; string[] sourceParts = AnchoredFile.Segments(source), targetParts = AnchoredFile.Segments(relative);
          if (version == 4 && (operations.Count != 1 || kind != "RENAME") || source.Length > 240 ||
              !Regex.IsMatch(source, "\\A[A-Za-z0-9_./-]+\\z") || sourceParts.Length != targetParts.Length ||
              !sourceParts.Take(sourceParts.Length - 1).SequenceEqual(targetParts.Take(targetParts.Length - 1), StringComparer.OrdinalIgnoreCase) ||
              String.Equals(source, relative, StringComparison.OrdinalIgnoreCase) || !Object.Equals(op["baseDigest"], op["newDigest"]) ||
              version == 5 && !names.Add(source)) throw new InvalidDataException();
        }
      }
    }
    static bool Transition(string from, string to, int previousOp, int nextOp, int count, int version) {
      if (version == 6) {
        if (count != 1 || previousOp != 0 || nextOp != 0 || from == "CLEANED" || from == "CONFLICT") return false;
        if (to == "CONFLICT") return true;
        return from == "PREPARED" && to == "MUTATION_STARTED" ||
          from == "MUTATION_STARTED" && to == "COMMITTED" ||
          from == "COMMITTED" && to == "POST_COMMIT_VERIFIED" ||
          from == "POST_COMMIT_VERIFIED" && to == "CLEANED";
      }
      if (version == 5) {
        if (from == "CLEANED" || from == "CONFLICT" || from == "MANUAL_RECOVERY_REQUIRED" || from == "ROLLED_BACK") return false;
        if (previousOp != nextOp) return from == "FINALIZED" && to == "PREPARED" && nextOp == previousOp + 1 && nextOp < count;
        if (to == "CONFLICT" || to == "MANUAL_RECOVERY_REQUIRED" || to == "RECOVERY_REQUIRED") return from != "FINALIZED";
        return from == "PREPARED" && to == "MUTATION_STARTED" || from == "MUTATION_STARTED" && to == "COMMITTED" ||
          from == "COMMITTED" && to == "POST_COMMIT_VERIFIED" || from == "POST_COMMIT_VERIFIED" && to == "FINALIZED" ||
          from == "FINALIZED" && previousOp == count - 1 && to == "CLEANUP_STARTED" ||
          from == "CLEANUP_STARTED" && previousOp == count - 1 && to == "CLEANED";
      }
      if (!Phases.Contains(to) || from == "CLEANED" || from == "ROLLED_BACK" || from == "FAILED" || from == "CONFLICT") return false;
      if (to == "CONFLICT" || to == "FAILED" || to == "RECOVERY_REQUIRED" || to == "ROLLBACK_REQUIRED") return previousOp == nextOp;
      if (from == "ROLLBACK_REQUIRED") return to == "ROLLED_BACK" && previousOp == nextOp;
      // Only the private V4 recovery adapter may append this observation. The
      // generic Advance endpoint still rejects every V2+ native phase.
      if (from == "RECOVERY_REQUIRED") return previousOp == nextOp && nextOp == count - 1 &&
        (version == 4 && to == "CLEANED" || version == 3 && (to == "CLEANUP_STARTED" || to == "CLEANED"));
      if (from == "VERIFIED" && to == "TEMP_WRITTEN") return nextOp == previousOp + 1 && nextOp < count;
      if (previousOp != nextOp) return false;
      string[] normal = version == 4 ? new string[] { "PREPARED", "RENAME_INTENT", "RENAMED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }
        : version == 3 ? new string[] { "PREPARED", "DELETE_INTENT", "DELETE_QUARANTINED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANUP_STARTED", "CLEANED" }
        : version == 2 ? new string[] { "PREPARED", "TEMP_CREATED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }
        : new string[] { "PREPARED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "COMMITTED", "VERIFIED", "CLEANED" };
      int index = Array.IndexOf(normal, from);
      return index >= 0 && index < normal.Length - 1 && normal[index + 1] == to && (to != "CLEANED" || nextOp == count - 1);
    }
    static void ValidateMixedEvent(Dictionary<string, object> original, Dictionary<string, object> body,
        string[] phases, string[] temps, string[] commits) {
      int index = (int)body["operationIndex"];
      string phase = (string)body["phase"], temp = body["tempIdentity"] as string, committed = body["committedIdentity"] as string;
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(original)[index];
      string kind = (string)op["kind"], expected = op["baseIdentity"] as string;
      if (phase == "PREPARED" && (phases[index] != "NOT_STARTED" || temp != null || committed != null) ||
          phase != "PREPARED" && phases[index] == "NOT_STARTED" ||
          phase == "MUTATION_STARTED" && (temp == null || committed != null) ||
          new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "FINALIZED", "CLEANUP_STARTED", "CLEANED" }.Contains(phase) &&
            (temp == null || committed == null) ||
          phase == "CLEANUP_STARTED" && (index != Operations(original).Count - 1 || phases[index] != "FINALIZED") ||
          phase == "CLEANED" && phases[index] != "CLEANUP_STARTED" ||
          new string[] { "DELETE", "RENAME", "REPLACE" }.Contains(kind) && committed != null && committed != expected ||
          new string[] { "DELETE", "RENAME" }.Contains(kind) && temp != null && temp != expected ||
          kind == "CREATE" && committed != null && committed != temp ||
          temps[index] != null && temp != temps[index] || commits[index] != null && committed != commits[index]) throw new InvalidDataException();
    }
    static void ValidateSingleCreateEvent(Dictionary<string, object> body, Dictionary<string, object> prior) {
      if ((int)body["operationIndex"] != 0) throw new InvalidDataException();
      string phase = (string)body["phase"], temp = body["tempIdentity"] as string, committed = body["committedIdentity"] as string;
      if (phase == "PREPARED") {
        if (temp != null || committed != null || prior != null) throw new InvalidDataException();
      } else if (phase == "MUTATION_STARTED") {
        if (temp == null || committed != null) throw new InvalidDataException();
      } else if (new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANED" }.Contains(phase)) {
        if (temp == null || committed != temp) throw new InvalidDataException();
      } else if (phase == "CONFLICT") {
        if (prior == null || temp != (prior["tempIdentity"] as string) || committed != (prior["committedIdentity"] as string)) throw new InvalidDataException();
      } else throw new InvalidDataException();
      if (prior != null && prior["tempIdentity"] != null && temp != (string)prior["tempIdentity"] ||
          prior != null && prior["committedIdentity"] != null && committed != (string)prior["committedIdentity"]) throw new InvalidDataException();
    }
    static Dictionary<string, object> Snapshot(string project, string expected, string ownedQuarantine = null) {
      using (RecoveryFilesystem pins = new RecoveryFilesystem(project)) {
        // Extraction has its existing independent file/content bounds. It is
        // never stored in the metadata journal or emitted as a receipt.
        JavaScriptSerializer extraction = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 16 };
        Dictionary<string, object> snapshot = extraction.Deserialize<Dictionary<string, object>>(extraction.Serialize(pins.ReadProjectSnapshot(false, ownedQuarantine)));
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
    bool TerminalReclaimProof(string expectedRootIdentity) {
      // This is intentionally narrower than ordinary recovery. In particular,
      // a pending DELETE quarantine, conflict or manual state is never a GC
      // candidate even if its creator has died or the registry is full.
      if ((string)header["projectIdentity"] != expectedRootIdentity ||
          RecoveryFilesystem.HandleIdentity(pins.DirectoryHandle) != expectedRootIdentity) return false;
      string phase = (string)last["phase"];
      if (phase != "CLEANED" && phase != "ROLLED_BACK") return false;
      int version = (int)header["version"];
      if (version == 4) return VerifiedRenameSnapshot(Snapshot(project, expectedRootIdentity), phase == "CLEANED");
      if (version != 3) return false; // V1/V2 have no complete GC proof yet.
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string[] parts = AnchoredFile.Segments((string)op["path"]);
      string path = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(path))) {
        DeleteObject current = ReadDeleteLeaf(parent, parts.Last());
        if (ReadDeleteLeaf(parent, DeleteLeaf(id)) != null) return false;
        if (phase == "CLEANED" && current != null || phase == "ROLLED_BACK" && !DeleteBaseMatches(current, op)) return false;
      }
      Dictionary<string, object> snapshot = Snapshot(project, expectedRootIdentity);
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"];
      if (phase == "CLEANED") return !files.ContainsKey((string)op["path"]) &&
        ProjectDraftDigest(files) == (string)header["verifiedDigest"];
      Dictionary<string, object> draft = new Dictionary<string, object>(files);
      if (!draft.Remove((string)op["path"])) return false;
      return ProjectBaseDigest(expectedRootIdentity, files, (Dictionary<string, object>)snapshot["identities"]) == (string)header["baseDigest"] &&
        ProjectDraftDigest(draft) == (string)header["verifiedDigest"];
    }
    string RetentionClass(string expectedRootIdentity) {
      bool alive; string generation = ScopeRecovery.ProcessCreation((int)header["creatorPid"], out alive);
      if (alive && generation == (string)header["creatorGeneration"]) return "ACTIVE";
      string phase = (string)last["phase"];
      if (phase == "CONFLICT") return "CONFLICT";
      if (phase == "FAILED") return "MANUAL_RECOVERY_REQUIRED";
      if (phase != "CLEANED" && phase != "ROLLED_BACK") return phase == "CLEANUP_STARTED" ? "COMMITTED_CLEANUP_PENDING" : "RECOVERY_PENDING";
      try { return TerminalReclaimProof(expectedRootIdentity) ? "SAFE_TO_RECLAIM" : "QUARANTINED_FOR_INSPECTION"; }
      catch { return "QUARANTINED_FOR_INSPECTION"; }
    }
    static string ReclaimForAdmission(RegistryKey root, string project, string expectedRootIdentity, string incoming, int capacity,
      out Dictionary<string, object> evidence) {
      evidence = null;
      // Admission is already held by the caller. Candidate leases are probed
      // without waiting, so an active publisher cannot deadlock with Begin.
      // Registry entries have values only; delete exactly one verified leaf,
      // never an entire tree or a project/quarantine file.
      string[] names = root.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).ToArray();
      if (capacity < 1 || capacity > MaxTransactions || names.Length > MaxTransactions) throw new InvalidDataException();
      if (names.Length < capacity) return "NOT_REQUIRED";
      foreach (string tx in names) {
        if (!Id.IsMatch(tx)) throw new InvalidDataException();
        Dictionary<string, object> first;
        using (RegistryKey key = root.OpenSubKey(tx, false)) {
          if (key == null) throw new InvalidDataException(); ScopeRecovery.ValidateRegistry(key);
          first = Decode(ReadValue(key, "E00000000"));
        }
        Keys(first, "sequence", "previousDigest", "phase", "operationIndex", "tempIdentity", "committedIdentity", "header");
        Dictionary<string, object> firstHeader = first["header"] as Dictionary<string, object>;
        ValidateHeader(firstHeader, tx);
        if (tx == incoming || (string)firstHeader["projectIdentity"] != expectedRootIdentity) continue;
        using (Mutex candidateLease = Lease(tx)) {
          if (!Acquire(candidateLease)) continue;
          try {
            bool safe; int journalVersion; string terminalPhase, journalDigest;
            using (PublicationJournal candidate = new PublicationJournal(tx, project))
            using (RegistryKey key = root.OpenSubKey(tx, false)) {
              if (key == null) throw new InvalidDataException(); candidate.ReadChain(key);
              if ((string)candidate.header["projectIdentity"] != expectedRootIdentity) throw new InvalidDataException();
              safe = candidate.RetentionClass(expectedRootIdentity) == "SAFE_TO_RECLAIM";
              journalVersion = (int)candidate.header["version"];
              terminalPhase = (string)candidate.last["phase"];
              journalDigest = candidate.lastDigest;
            }
            if (!safe) continue;
            // RegDeleteKeyW rejects subkeys. A successful single-key delete is
            // flushed at the parent. Any uncertain crash observation remains
            // fail-closed; it is not treated as proof of successful cleanup.
            if (RegDeleteKeyW(root.Handle.DangerousGetHandle(), tx) != 0 ||
                RegFlushKey(root.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
            using (RegistryKey remaining = root.OpenSubKey(tx, false)) if (remaining != null) throw new InvalidDataException();
            evidence = new Dictionary<string, object> {
              { "version", 1 }, { "selectedTransactionId", tx }, { "journalVersion", journalVersion },
              { "terminalPhase", terminalPhase }, { "journalDigest", journalDigest },
              { "eligibility", "SAFE_TO_RECLAIM" }, { "reason", "TERMINAL_CHAIN_AND_FILESYSTEM_VERIFIED" },
              { "filesystemVerified", true }, { "result", "RECLAIMED_TERMINAL" },
              { "capacityBefore", names.Length }, { "capacityAfterReclaim", names.Length - 1 },
              { "capacityAfterAdmission", (object)null }
            };
            return "RECLAIMED_TERMINAL";
          } finally { candidateLease.ReleaseMutex(); }
        }
      }
      throw new InvalidOperationException("PHI_PUBLICATION_CAPACITY_BLOCKED");
    }
    static string RetentionFixturePressure(string project, string expectedRootIdentity, string incoming) {
      // Fixture-only reduced pressure threshold; production always uses 64.
      using (Mutex admission = Lease(incoming, true)) {
        if (!Acquire(admission, 1000)) throw new InvalidDataException();
        try { using (RegistryKey root = OpenBase(true)) {
          int occupied = root.GetSubKeyNames().Length;
          Dictionary<string, object> ignored;
          return ReclaimForAdmission(root, project, expectedRootIdentity, incoming, occupied, out ignored);
        } } finally { admission.ReleaseMutex(); }
      }
    }
    PublicationJournal(string transactionId, string projectRoot) {
      if (!Id.IsMatch(transactionId)) throw new InvalidDataException(); id = transactionId; project = projectRoot;
      lease = Lease(id);
      try { acquired = Acquire(lease); if (!acquired) throw new InvalidDataException(); pins = new RecoveryFilesystem(project); }
      catch { Dispose(); throw; }
    }
    internal static PublicationJournal Begin(string project, Dictionary<string, object> metadata, Action fixtureAfterReclaim = null) {
      // Freeze through a serialization copy; callers cannot mutate the header.
      Dictionary<string, object> value = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(metadata));
      string transactionId = value["transactionId"] as string; ValidateHeader(value, transactionId);
      bool alive; int pid = Process.GetCurrentProcess().Id;
      if ((int)value["creatorPid"] != pid || ScopeRecovery.ProcessCreation(pid, out alive) != (string)value["creatorGeneration"] || !alive) throw new InvalidDataException();
      PublicationJournal result = new PublicationJournal(transactionId, project);
      try {
        bool baseMatches = MatchesBase(project, value);
        if (baseMatches && (int)value["version"] == 6) {
          Dictionary<string, object> before = Snapshot(project, (string)value["projectIdentity"]);
          baseMatches = ProjectBaseDigest((string)value["projectIdentity"],
            (Dictionary<string, object>)before["files"], (Dictionary<string, object>)before["identities"]) == (string)value["baseDigest"];
        }
        if (!baseMatches) {
          // Keep V1 semantics and unknown/root/schema/sharing exceptions intact.
          // Only known V2 destination absence/identity/content mismatch reaches
          // this branch. No journal key or native transaction exists yet.
          if ((int)value["version"] >= 2) throw new AdmissionConflict(value);
          throw new InvalidDataException();
        }
        using (Mutex admission = Lease(transactionId, true)) {
          if (!Acquire(admission, 1000)) throw new InvalidDataException();
          try { using (RegistryKey root = OpenBase(true)) {
          if (root.GetSubKeyNames().Length >= MaxTransactions)
            ReclaimForAdmission(root, project, (string)value["projectIdentity"], transactionId, MaxTransactions, out result.reclamation);
          if (root.GetSubKeyNames().Length >= MaxTransactions) throw new InvalidOperationException("PHI_PUBLICATION_CAPACITY_BLOCKED");
          // Only the native crash fixture supplies this in-process callback.
          // Production endpoints never accept a callback or a pause parameter.
          if (result.reclamation != null && fixtureAfterReclaim != null) fixtureAfterReclaim();
          using (RegistryKey existing = root.OpenSubKey(transactionId)) if (existing != null) throw new InvalidDataException();
          using (RegistryKey key = root.CreateSubKey(transactionId, RegistryKeyPermissionCheck.ReadWriteSubTree, RegistryOptions.None, ScopeRecovery.PrivateRegistryAcl())) {
            result.header = value; result.Append(key, "PREPARED", 0, null, null);
          }
          if (result.reclamation != null) {
            int afterAdmission = root.GetSubKeyNames().Length;
            if (afterAdmission != MaxTransactions) throw new InvalidDataException();
            result.reclamation["capacityAfterAdmission"] = afterAdmission;
          }
          } } finally { admission.ReleaseMutex(); }
        }
        return result;
      } catch { result.Dispose(); throw; } // incomplete/unknown key retained, never guessed away
    }
    void Append(RegistryKey key, string phase, int operationIndex, string tempIdentity, string committedIdentity, bool nativeObservation = false, string terminalObservation = null) {
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
      if (terminalObservation != null) {
        if ((int)header["version"] != 5 || phase != "CLEANED" || operationIndex != 3 ||
            terminalObservation != RecoveryTerminalObservation || !nativeObservation) throw new InvalidDataException();
        body.Add("terminalObservation", terminalObservation);
      }
      if ((int)header["version"] == 5) {
        string[] phases = mixedPhases ?? Enumerable.Repeat("NOT_STARTED", Operations(header).Count).ToArray();
        ValidateMixedEvent(header, body, phases, mixedTempIdentities ?? new string[phases.Length], mixedCommittedIdentities ?? new string[phases.Length]);
      }
      if ((int)header["version"] == 6) ValidateSingleCreateEvent(body, last);
      string name = "E" + sequence.ToString("D8");
      if (key.GetValueNames().Contains(name)) throw new InvalidDataException();
      byte[] bytes = Envelope(body);
      try {
        ScopeRecovery.ValidateRegistry(key);
        if (terminalObservation == RecoveryTerminalObservation) recoveryJournalAppendAttempted = true;
        key.SetValue(name, bytes, RegistryValueKind.Binary);
        if (terminalObservation == RecoveryTerminalObservation && fixtureAfterRecoveryTerminalSetValue != null)
          fixtureAfterRecoveryTerminalSetValue(); // Fixed native interruption fixture only.
        if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0 || !ReadValue(key, name).SequenceEqual(bytes)) throw new InvalidDataException();
        // Flush both the transaction and its parent key before claiming PREPARED.
        if (sequence == 0) using (RegistryKey root = OpenBase(true)) if (RegFlushKey(root.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
      } catch { poisoned = true; throw; }
      last = body; lastDigest = Hash(bytes);
      if ((int)header["version"] == 3 && phase == "CLEANUP_STARTED") deleteCleanupIntent = true;
      if ((int)header["version"] == 5) {
        if (mixedPhases == null) {
          mixedPhases = Enumerable.Repeat("NOT_STARTED", Operations(header).Count).ToArray();
          mixedTempIdentities = new string[mixedPhases.Length]; mixedCommittedIdentities = new string[mixedPhases.Length];
        }
        mixedPhases[operationIndex] = phase; mixedTempIdentities[operationIndex] = tempIdentity; mixedCommittedIdentities[operationIndex] = committedIdentity;
      }
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
    // V5 operations use the same native mutation primitives as their single-
    // operation counterparts. The publisher records its phases; the bounded
    // known-transaction recovery path may record only a terminal observation.
    void ObserveMixed(int index, string phase, string tempIdentity, string committedIdentity, string terminalObservation = null) {
      if ((int)header["version"] != 5 || index < 0 || index >= Operations(header).Count) throw new InvalidDataException();
      using (RegistryKey root = OpenBase(true)) using (RegistryKey key = root.OpenSubKey(id, true)) {
        if (key == null) throw new InvalidDataException();
        ReadChain(key);
        Append(key, phase, index, tempIdentity, committedIdentity, true, terminalObservation);
      }
    }
    void PublishMixedModify(byte[] bytes, Action<string> checkpoint) {
      if ((int)header["version"] != 5 || (int)last["operationIndex"] != 0 || (string)last["phase"] != "PREPARED") throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      if (bytes == null || bytes.Length != (int)op["newBytes"] || Hash(bytes) != (string)op["newDigest"]) throw new InvalidDataException();
      string expected = (string)op["baseIdentity"];
      AtomicModify.ReplaceDefaultStream(project, (string)header["projectIdentity"], (string)op["path"], expected,
        (string)op["baseDigest"], bytes, delegate(string phase, string temp) {
          if (phase == "locked") ObserveMixed(0, "MUTATION_STARTED", temp, null);
          else if (phase == "committed") ObserveMixed(0, "COMMITTED", temp, expected);
          else if (phase == "postverify") ObserveMixed(0, "POST_COMMIT_VERIFIED", temp, expected);
          else if (phase == "cleanup") ObserveMixed(0, "FINALIZED", temp, expected);
          checkpoint("modify-" + phase);
        });
      if (mixedPhases[0] != "FINALIZED") throw new InvalidDataException();
    }
    void PublishMixedCreate(byte[] bytes, Action<string> checkpoint) {
      if ((int)header["version"] != 5 || (int)last["operationIndex"] != 1 || (string)last["phase"] != "PREPARED") throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[1];
      if (bytes == null || bytes.Length != (int)op["newBytes"] || Hash(bytes) != (string)op["newDigest"]) throw new InvalidDataException();
      string createdIdentity = null;
      AnchoredFile.CreateNoReplace(project, (string)header["projectIdentity"], (string)op["path"], bytes,
        "phi-publish-" + id + ".tmp", delegate(string phase, string identity) {
          if (phase == "temp") ObserveMixed(1, "MUTATION_STARTED", identity, null);
          else if (phase == "rename") ObserveMixed(1, "COMMITTED", identity, identity);
          else if (phase == "postverify") { ObserveMixed(1, "POST_COMMIT_VERIFIED", identity, identity); createdIdentity = identity; }
          checkpoint("create-" + phase);
        });
      if (createdIdentity == null) throw new InvalidDataException();
      ObserveMixed(1, "FINALIZED", createdIdentity, createdIdentity);
      checkpoint("create-finalized");
    }
    void PublishMixedDelete(Action<string> checkpoint) {
      if ((int)header["version"] != 5 || (int)last["operationIndex"] != 2 || (string)last["phase"] != "PREPARED") throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[2];
      string[] parts = AnchoredFile.Segments((string)op["path"]);
      string path = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
      string expected = (string)op["baseIdentity"], quarantine = DeleteLeaf(id);
      IntPtr source = IntPtr.Zero;
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(path))) {
        try {
          RecoveryFilesystem.Info info;
          source = parent.OpenDeleteSource(parts.Last(), out info);
          if (!DeleteBaseMatches(ReadDeleteObject(source), op) || ReadDeleteLeaf(parent, quarantine) != null)
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          ObserveMixed(2, "MUTATION_STARTED", expected, null); checkpoint("delete-intent");
          if (!DeleteBaseMatches(ReadDeleteObject(source), op)) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          parent.QuarantineDeleteSource(source, quarantine); checkpoint("delete-renamed");
          if (ReadDeleteLeaf(parent, parts.Last()) != null || !DeleteBaseMatches(ReadDeleteObject(source), op))
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          ObserveMixed(2, "COMMITTED", expected, expected); checkpoint("delete-committed");
          if (ReadDeleteLeaf(parent, parts.Last()) != null || !DeleteBaseMatches(ReadDeleteObject(source), op))
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          ObserveMixed(2, "POST_COMMIT_VERIFIED", expected, expected); checkpoint("delete-verified");
          // Keep the exact quarantined object until all four mutations and the
          // full verified draft have passed. No pathname unlink occurs here.
          ObserveMixed(2, "FINALIZED", expected, expected); checkpoint("delete-finalized-retained");
        } finally { CloseNative(source); }
      }
    }
    void PublishMixedRename(Action<string> checkpoint) {
      if ((int)header["version"] != 5 || (int)last["operationIndex"] != 3 || (string)last["phase"] != "PREPARED") throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[3];
      string[] sourceParts = AnchoredFile.Segments((string)op["sourcePath"]), targetParts = AnchoredFile.Segments((string)op["path"]);
      string sourcePath = sourceParts.Aggregate(project, (current, part) => Path.Combine(current, part));
      string expected = (string)op["baseIdentity"];
      IntPtr source = IntPtr.Zero;
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(sourcePath))) {
        try {
          RecoveryFilesystem.Info info;
          source = parent.OpenRenameSource(sourceParts.Last(), out info);
          DeleteObject held = ReadDeleteObject(source);
          if (!DeleteBaseMatches(held, op) || held.Bytes != (int)op["newBytes"] || ReadDeleteLeaf(parent, targetParts.Last()) != null)
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          ObserveMixed(3, "MUTATION_STARTED", expected, null); checkpoint("rename-intent");
          if (!DeleteBaseMatches(ReadDeleteObject(source), op) || ReadDeleteLeaf(parent, targetParts.Last()) != null)
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          parent.RenameExpectedSource(source, sourceParts.Last(), targetParts.Last(), expected, (string)op["baseDigest"]);
          checkpoint("rename-moved");
          if (ReadDeleteLeaf(parent, sourceParts.Last()) != null || !DeleteBaseMatches(ReadDeleteObject(source), op))
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          ObserveMixed(3, "COMMITTED", expected, expected); checkpoint("rename-committed");
          CloseNative(source); source = IntPtr.Zero;
          DeleteObject destination = ReadDeleteLeaf(parent, targetParts.Last());
          if (ReadDeleteLeaf(parent, sourceParts.Last()) != null || !DeleteBaseMatches(destination, op) || destination.Bytes != (int)op["newBytes"])
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          ObserveMixed(3, "POST_COMMIT_VERIFIED", expected, expected); checkpoint("rename-verified");
          ObserveMixed(3, "FINALIZED", expected, expected); checkpoint("rename-finalized");
        } finally { CloseNative(source); }
      }
    }
    void PublishMixedCleanup(Action<string> checkpoint) {
      if ((int)header["version"] != 5 || (int)last["operationIndex"] != 3 || (string)last["phase"] != "FINALIZED") throw new InvalidDataException();
      Dictionary<string, object> deletion = (Dictionary<string, object>)Operations(header)[2];
      Dictionary<string, object> rename = (Dictionary<string, object>)Operations(header)[3];
      string[] parts = AnchoredFile.Segments((string)deletion["path"]);
      string path = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
      string quarantine = DeleteLeaf(id), expected = (string)deletion["baseIdentity"];
      string excluded = String.Join("/", parts.Take(parts.Length - 1).Concat(new string[] { quarantine }));
      Dictionary<string, object> snapshot = Snapshot(project, (string)header["projectIdentity"], excluded);
      if (ProjectDraftDigest((Dictionary<string, object>)snapshot["files"]) != (string)header["verifiedDigest"])
        throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(path))) {
        IntPtr held = IntPtr.Zero;
        try {
          RecoveryFilesystem.Info info;
          held = parent.OpenDeleteSource(quarantine, out info);
          if (!DeleteBaseMatches(ReadDeleteObject(held), deletion) || ReadDeleteLeaf(parent, parts.Last()) != null)
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          string renameExpected = (string)rename["baseIdentity"];
          ObserveMixed(3, "CLEANUP_STARTED", renameExpected, renameExpected); checkpoint("cleanup-intent");
          if (!DeleteBaseMatches(ReadDeleteObject(held), deletion) || ReadDeleteLeaf(parent, parts.Last()) != null)
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          parent.UnlinkQuarantinedFile(held, expected); CloseNative(held); held = IntPtr.Zero;
          checkpoint("cleanup-unlinked");
          if (ReadDeleteLeaf(parent, quarantine) != null || ReadDeleteLeaf(parent, parts.Last()) != null)
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          snapshot = Snapshot(project, (string)header["projectIdentity"]);
          if (ProjectDraftDigest((Dictionary<string, object>)snapshot["files"]) != (string)header["verifiedDigest"])
            throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
          ObserveMixed(3, "CLEANED", renameExpected, renameExpected); checkpoint("cleanup-cleaned");
        } finally { CloseNative(held); }
      }
    }
    internal object PublishMixed(byte[] modify, byte[] create, Action<string> checkpoint) {
      if ((int)header["version"] != 5 || (string)last["phase"] != "PREPARED" || (int)last["operationIndex"] != 0 || checkpoint == null)
        throw new InvalidDataException();
      PublishMixedModify(modify, checkpoint);
      ObserveMixed(1, "PREPARED", null, null); checkpoint("create-prepared");
      PublishMixedCreate(create, checkpoint);
      ObserveMixed(2, "PREPARED", null, null); checkpoint("delete-prepared");
      PublishMixedDelete(checkpoint);
      ObserveMixed(3, "PREPARED", null, null); checkpoint("rename-prepared");
      PublishMixedRename(checkpoint);
      PublishMixedCleanup(checkpoint);
      if ((string)last["phase"] != "CLEANED" || mixedPhases.Any(phase => phase != "FINALIZED" && phase != "CLEANED"))
        throw new InvalidDataException();
      return new { journal = Metadata("NOT_REQUIRED"), nativeProof = new { backend = "V5_BOUNDED_NATIVE_MIXED",
        operations = 4, createIdentity = mixedCommittedIdentities[1], deleteIdentity = mixedCommittedIdentities[2],
        renameIdentity = mixedCommittedIdentities[3], quarantineAbsent = true, verifiedDraftDigest = header["verifiedDigest"],
        committed = true, projectPublished = false } };
    }
    internal static int RunMixed(Stream input) {
      PublicationJournal journal = null; string phase = "REQUEST";
      try {
        byte[] requestBytes;
        using (MemoryStream line = new MemoryStream()) {
          bool complete = false;
          for (int i = 0; i < 1024 * 1024; i++) { int next = input.ReadByte(); if (next < 0) throw new InvalidDataException();
            if (next == 10) { complete = true; break; } line.WriteByte((byte)next); }
          if (!complete) throw new InvalidDataException(); requestBytes = line.ToArray();
        }
        JavaScriptSerializer reader = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 16 };
        Dictionary<string, object> request = reader.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(requestBytes));
        Keys(request, "version", "root", "header", "modifyContent", "createContent", "guardianPid", "timeoutMs"); Number(request, "version", 1, 1);
        string project = request["root"] as string, modifyText = request["modifyContent"] as string, createText = request["createContent"] as string;
        if (project == null || project.Length > 1024 || project.IndexOf('\0') >= 0 || !Path.IsPathRooted(project) ||
            modifyText == null || modifyText.IndexOf('\0') >= 0 || createText == null || createText.IndexOf('\0') >= 0) throw new InvalidDataException();
        byte[] modify = new UTF8Encoding(false, true).GetBytes(modifyText), create = new UTF8Encoding(false, true).GetBytes(createText);
        Dictionary<string, object> header = request["header"] as Dictionary<string, object>;
        Keys(header, "transactionId", "projectIdentity", "draftId", "draftVersion", "verifiedDigest", "baseDigest", "operations");
        bool alive; int pid = Process.GetCurrentProcess().Id;
        header.Add("version", 5); header.Add("creatorPid", pid); header.Add("creatorGeneration", ScopeRecovery.ProcessCreation(pid, out alive));
        if (!alive) throw new InvalidDataException(); ValidateHeader(header, header["transactionId"] as string);
        Dictionary<string, object> first = (Dictionary<string, object>)Operations(header)[0], second = (Dictionary<string, object>)Operations(header)[1];
        if (modify.Length != (int)first["newBytes"] || Hash(modify) != (string)first["newDigest"] ||
            create.Length != (int)second["newBytes"] || Hash(create) != (string)second["newDigest"]) throw new InvalidDataException();
        object result = null;
        OwnedProcess.WithPublicationGuardian(Number(request, "guardianPid", 1, Int32.MaxValue), Number(request, "timeoutMs", 1, 30000), delegate(Action live) {
          phase = "ADMISSION"; journal = Begin(project, header); phase = "PREPARED";
          result = journal.PublishMixed(modify, create, delegate(string observed) { phase = observed; live(); });
        });
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_NATIVE_MIXED", receipt = result,
          retention = journal.ReclamationMetadata, projectPublished = false, externalRequests = 0 })); return 0;
      } catch (Exception error) {
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_NATIVE_MIXED", phase,
          reason = error is AdmissionConflict || error is InvalidOperationException && error.Message == "PHI_PUBLICATION_CONFLICT" ? "CONFLICT" : "UNCONFIRMED",
          nativeCode = unchecked((uint)Marshal.GetHRForException(error)).ToString("x8"), journal = journal == null ? null : journal.Metadata("INSPECTION_REQUIRED"),
          admission = error is AdmissionConflict ? ((AdmissionConflict)error).Evidence : null,
          projectPublished = false, externalRequests = 0 })); return 70;
      } finally { if (journal != null) journal.Dispose(); }
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
    // D-13 native integration fixture only: a fail-closed publisher death at
    // an already-durable V2 phase. This never grants publication or recovery.
    static bool D13FixtureInterruptsV2Temp(string project) {
      if (Environment.GetEnvironmentVariable("PHI_D13_V2_TEMP_FAILPOINT") != "1" ||
          Environment.GetEnvironmentVariable("PHI_BOUNDED_TEST_KEY") != "offline-fixture-not-a-credential") return false;
      string share = Environment.GetEnvironmentVariable("PI_OVERDRIVE_WORKTREE_ROOT");
      if (String.IsNullOrEmpty(share)) return false;
      try {
        string canonicalShare = Path.GetFullPath(share).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string canonicalProject = Path.GetFullPath(project);
        string step = Path.GetFileName(Path.GetDirectoryName(canonicalShare));
        string fixture = Path.GetFileName(Path.GetDirectoryName(Path.GetDirectoryName(canonicalShare)));
        return step == "step-2" && fixture.StartsWith("phi-d-restart-", StringComparison.Ordinal) &&
          canonicalProject.StartsWith(canonicalShare + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
      } catch { return false; }
    }
    // Campaign-3 E3 fixture only: hold an already-durable V2 TEMP_CREATED
    // boundary until the test owner terminates its own autonomous Pi root.
    // The existing publication guardian then terminates this publisher; no
    // production recovery/publication authority is added.
    static bool E3FixtureWaitsAtV2Temp(string project) {
      if (Environment.GetEnvironmentVariable("PHI_E3_V2_TEMP_WAIT") != "1" ||
          Environment.GetEnvironmentVariable("PHI_BOUNDED_TEST_KEY") != "offline-fixture-not-a-credential") return false;
      string share = Environment.GetEnvironmentVariable("PI_OVERDRIVE_WORKTREE_ROOT");
      if (String.IsNullOrEmpty(share)) return false;
      try {
        string canonicalShare = Path.GetFullPath(share).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string canonicalProject = Path.GetFullPath(project);
        string step = Path.GetFileName(Path.GetDirectoryName(canonicalShare));
        string fixture = Path.GetFileName(Path.GetDirectoryName(Path.GetDirectoryName(canonicalShare)));
        return step == "step-2" && fixture.StartsWith("phi-e3-crash-", StringComparison.Ordinal) &&
          canonicalProject.StartsWith(canonicalShare + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
      } catch { return false; }
    }
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
        bool d13FixtureInterrupt = D13FixtureInterruptsV2Temp(project);
        bool e3FixtureWait = E3FixtureWaitsAtV2Temp(project);
        OwnedProcess.WithPublicationGuardian(Number(request, "guardianPid", 1, Int32.MaxValue), Number(request, "timeoutMs", 1, 30000), delegate(Action live) {
          phase = "ADMISSION"; journal = Begin(project, header); phase = "PREPARED";
          result = journal.PublishSingleModify(value, delegate(string observed) {
            phase = observed; live();
            if (d13FixtureInterrupt && observed == "temp" && (string)journal.last["phase"] == "TEMP_CREATED")
              Environment.Exit(76);
            if (e3FixtureWait && observed == "temp" && (string)journal.last["phase"] == "TEMP_CREATED") {
              string share = Environment.GetEnvironmentVariable("PI_OVERDRIVE_WORKTREE_ROOT");
              string marker = Path.Combine(Path.GetDirectoryName(share), "e3-temp-ready");
              using (FileStream signal = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                byte[] markerBytes = Encoding.ASCII.GetBytes("TEMP_CREATED");
                signal.Write(markerBytes, 0, markerBytes.Length); signal.Flush(true);
              }
              using (Process owner = Process.GetProcessById(Number(request, "guardianPid", 1, Int32.MaxValue)))
                if (!owner.WaitForExit(Number(request, "timeoutMs", 1, 30000))) Environment.Exit(77);
              Environment.Exit(76);
            }
          });
        });
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_NATIVE_SINGLE_MODIFY", receipt = result,
          retention = journal.ReclamationMetadata, projectPublished = false, externalRequests = 0 })); return 0;
      } catch (Exception error) {
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_NATIVE_SINGLE_MODIFY", phase,
          reason = error is AdmissionConflict || error is InvalidOperationException && error.Message == "PHI_PUBLICATION_CONFLICT" ? "CONFLICT" : "UNCONFIRMED",
          nativeCode = unchecked((uint)Marshal.GetHRForException(error)).ToString("x8"),
          journal = journal == null ? null : journal.Metadata("INSPECTION_REQUIRED"), admission = error is AdmissionConflict ? ((AdmissionConflict)error).Evidence : null,
          projectPublished = false, externalRequests = 0 })); return 70;
      } finally { if (journal != null) journal.Dispose(); }
    }
    internal object PublishSingleCreate(byte[] bytes, Action<string> checkpoint) {
      if ((int)header["version"] != 6 || (string)last["phase"] != "PREPARED") throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      if (bytes == null || bytes.Length != (int)op["newBytes"] || Hash(bytes) != (string)op["newDigest"]) throw new InvalidDataException();
      string createdIdentity = null;
      try {
        AnchoredFile.CreateNoReplace(project, (string)header["projectIdentity"], (string)op["path"], bytes,
          "phi-publish-" + id + ".tmp", delegate(string phase, string identity) {
            if (phase == "temp") Observe("MUTATION_STARTED", identity, null);
            else if (phase == "rename") Observe("COMMITTED", identity, identity);
            else if (phase == "postverify") { Observe("POST_COMMIT_VERIFIED", identity, identity); createdIdentity = identity; }
            checkpoint("create-" + phase);
          });
        if (createdIdentity == null) throw new InvalidDataException();
        Dictionary<string, object> final = Snapshot(project, (string)header["projectIdentity"]);
        Dictionary<string, object> files = (Dictionary<string, object>)final["files"], identities = (Dictionary<string, object>)final["identities"];
        string[] parts = AnchoredFile.Segments((string)op["path"]);
        string target = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
        bool tempAbsent;
        using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(target)))
          tempAbsent = ReadDeleteLeaf(parent, "phi-publish-" + id + ".tmp") == null;
        if (ProjectDraftDigest(files) != (string)header["verifiedDigest"] ||
            !files.ContainsKey((string)op["path"]) || (string)identities[(string)op["path"]] != createdIdentity ||
            !tempAbsent) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
        Observe("CLEANED", createdIdentity, createdIdentity); checkpoint("create-cleaned");
        return new { journal = Metadata("NOT_REQUIRED"), nativeProof = new { backend = "JOURNALED_NO_CLOBBER_CREATE",
          createdIdentity, digest = op["newDigest"], noClobber = true, committed = true, tempAbsent = true, projectPublished = false } };
      } catch (InvalidOperationException error) {
        if (error.Message != "PHI_PUBLICATION_CONFLICT") throw;
        if ((string)last["phase"] != "CONFLICT") Observe("CONFLICT", last["tempIdentity"] as string, last["committedIdentity"] as string);
        throw;
      }
    }
    internal static int RunSingleCreate(Stream input) {
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
        header.Add("version", 6); header.Add("creatorPid", pid); header.Add("creatorGeneration", ScopeRecovery.ProcessCreation(pid, out alive));
        if (!alive) throw new InvalidDataException(); ValidateHeader(header, header["transactionId"] as string);
        Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
        if (value.Length != (int)op["newBytes"] || Hash(value) != (string)op["newDigest"]) throw new InvalidDataException();
        OwnedProcess.WithPublicationGuardian(Number(request, "guardianPid", 1, Int32.MaxValue), Number(request, "timeoutMs", 1, 30000), delegate(Action live) {
          phase = "ADMISSION"; journal = Begin(project, header); phase = "PREPARED";
          result = journal.PublishSingleCreate(value, delegate(string observed) { phase = observed; live(); });
        });
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_NATIVE_SINGLE_CREATE", receipt = result,
          retention = journal.ReclamationMetadata, projectPublished = false, externalRequests = 0 })); return 0;
      } catch (Exception error) {
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_NATIVE_SINGLE_CREATE", phase,
          reason = error is AdmissionConflict || error is InvalidOperationException && error.Message == "PHI_PUBLICATION_CONFLICT" ? "CONFLICT" : "UNCONFIRMED",
          nativeCode = unchecked((uint)Marshal.GetHRForException(error)).ToString("x8"), journal = journal == null ? null : journal.Metadata("INSPECTION_REQUIRED"),
          admission = error is AdmissionConflict ? ((AdmissionConflict)error).Evidence : null, projectPublished = false, externalRequests = 0 })); return 70;
      } finally { if (journal != null) journal.Dispose(); }
    }
    object InspectSingleCreate() {
      if ((int)header["version"] != 6) throw new InvalidDataException();
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string[] parts = AnchoredFile.Segments((string)op["path"]);
      string targetPath = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
      DeleteObject target, temp;
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(targetPath))) {
        target = ReadDeleteLeaf(parent, parts.Last());
        temp = ReadDeleteLeaf(parent, "phi-publish-" + id + ".tmp");
      }
      string phase = (string)last["phase"], recorded = last["tempIdentity"] as string;
      string status = "UNKNOWN_FAIL_SAFE";
      if (phase == "CONFLICT") status = "CONFLICT";
      else if (target == null && temp == null) {
        Dictionary<string, object> current = Snapshot(project, (string)header["projectIdentity"]);
        bool baseMatches = ProjectBaseDigest((string)header["projectIdentity"],
          (Dictionary<string, object>)current["files"], (Dictionary<string, object>)current["identities"]) == (string)header["baseDigest"];
        status = baseMatches && phase == "PREPARED" ? "OLD_COMPLETE_OBSERVED" : "CONFLICT";
      } else if (target != null && temp == null) {
        Dictionary<string, object> current = Snapshot(project, (string)header["projectIdentity"]);
        bool verified = recorded != null && target.Identity == recorded && target.Digest == (string)op["newDigest"] &&
          target.Bytes == (int)op["newBytes"] &&
          ProjectDraftDigest((Dictionary<string, object>)current["files"]) == (string)header["verifiedDigest"];
        status = verified && phase != "PREPARED" ? "NEW_COMPLETE_OBSERVED" : "CONFLICT";
      } else if (target != null || temp.Identity != recorded || temp.Digest != (string)op["newDigest"] ||
          temp.Bytes != (int)op["newBytes"]) status = "CONFLICT";
      // A staged temporary object or a physical commit before its durable
      // record is observation only. No automatic cleanup/resume is granted.
      return new { status, metadata = Metadata(status == "CONFLICT" ? "CONFLICT" : phase == "CLEANED" && status == "NEW_COMPLETE_OBSERVED" ?
          "TERMINAL_RETAINED" : "MANUAL_RECOVERY_REQUIRED"), ownerGenerationAlive = false,
        observedIdentity = target == null ? null : target.Identity, tempIdentity = temp == null ? null : temp.Identity,
        journalMutations = 0, projectMutations = 0, processKills = 0, projectPublished = false };
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
        else if (current == null && ownedQuarantine && last["tempIdentity"] != null && new string[] { "DELETE_INTENT", "DELETE_QUARANTINED", "ROLLBACK_REQUIRED", "COMMITTED", "POST_COMMIT_VERIFIED", "CLEANUP_STARTED", "RECOVERY_REQUIRED" }.Contains(phase)) status = "DELETE_COMMITTED_QUARANTINE_RETAINED";
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
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_NATIVE_SINGLE_DELETE", receipt = result,
          retention = journal.ReclamationMetadata, projectPublished = false, externalRequests = 0 })); return 0;
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
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_NATIVE_SINGLE_RENAME", receipt = result,
          retention = journal.ReclamationMetadata, projectPublished = false, externalRequests = 0 })); return 0;
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
      string[] operationPhases = null, operationTemps = null, operationCommits = null;
      for (int i = 0; i < names.Length; i++) {
        if (names[i] != "E" + i.ToString("D8")) throw new InvalidDataException();
        byte[] bytes = ReadValue(key, names[i]); Dictionary<string, object> body = Decode(bytes);
        if (body.ContainsKey("terminalObservation"))
          Keys(body, "sequence", "previousDigest", "phase", "operationIndex", "tempIdentity", "committedIdentity", "header", "terminalObservation");
        else Keys(body, "sequence", "previousDigest", "phase", "operationIndex", "tempIdentity", "committedIdentity", "header");
        if (Number(body, "sequence", 0, MaxEvents - 1) != i || StringField(body, "previousDigest", Digest) != previous || !(body["phase"] is string) || !Phases.Contains((string)body["phase"])) throw new InvalidDataException();
        if (i == 0) {
          original = body["header"] as Dictionary<string, object>; ValidateHeader(original, id);
          if ((string)body["phase"] != "PREPARED" || Number(body, "operationIndex", 0, 0) != 0) throw new InvalidDataException();
          if ((int)original["version"] == 5) {
            operationPhases = Enumerable.Repeat("NOT_STARTED", Operations(original).Count).ToArray();
            operationTemps = new string[operationPhases.Length]; operationCommits = new string[operationPhases.Length];
          }
        }
        else if (body["header"] != null || !Transition((string)prior["phase"], (string)body["phase"], (int)prior["operationIndex"], Number(body, "operationIndex", 0, Operations(original).Count - 1), Operations(original).Count, (int)original["version"])) throw new InvalidDataException();
        if (body.ContainsKey("terminalObservation") && ((int)original["version"] != 5 ||
            (string)body["phase"] != "CLEANED" || (int)body["operationIndex"] != 3 ||
            body["terminalObservation"] as string != RecoveryTerminalObservation)) throw new InvalidDataException();
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
        if ((int)original["version"] == 5) {
          int index = (int)body["operationIndex"];
          ValidateMixedEvent(original, body, operationPhases, operationTemps, operationCommits);
          operationPhases[index] = (string)body["phase"];
          operationTemps[index] = body["tempIdentity"] as string;
          operationCommits[index] = body["committedIdentity"] as string;
        }
        if ((int)original["version"] == 6) ValidateSingleCreateEvent(body, prior);
        previous = Hash(bytes); prior = body;
      }
      if (lastDigest != null && previous != lastDigest) throw new InvalidDataException();
      header = original; last = prior; lastDigest = previous; deleteCleanupIntent = cleanupIntent;
      mixedPhases = operationPhases; mixedTempIdentities = operationTemps; mixedCommittedIdentities = operationCommits;
    }
    internal object ReclamationMetadata { get { return reclamation; } }
    internal object Metadata(string recovery, string observedFilesystemState = "UNVERIFIED") {
      if ((int)header["version"] == 5) {
        if (mixedPhases == null || mixedPhases.Length != Operations(header).Count) throw new InvalidDataException();
        var states = Operations(header).Cast<Dictionary<string, object>>().Select((op, index) => new {
          operationIndex = index, kind = op["kind"], sourcePath = op.ContainsKey("sourcePath") ? op["sourcePath"] : null,
          destinationPath = op["path"], baseIdentity = op["baseIdentity"], baseDigest = op["baseDigest"],
          expectedResultDigest = op["newDigest"], expectedResultBytes = op["newBytes"],
          durablePhase = mixedPhases[index], recordedTempIdentity = mixedTempIdentities[index], recordedCommittedIdentity = mixedCommittedIdentities[index]
        }).ToArray();
        int committed = mixedPhases.Count(phase => new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "FINALIZED", "CLEANUP_STARTED", "CLEANED" }.Contains(phase));
        string journalState = mixedPhases.Contains("CONFLICT") ? "CONFLICT" : mixedPhases.Contains("MANUAL_RECOVERY_REQUIRED") ? "MANUAL_RECOVERY_REQUIRED" :
          (string)last["phase"] == "CLEANED" ? "FINALIZED" : committed == 0 ? "NONE_COMMITTED" :
          committed == mixedPhases.Length ? "ALL_FILESYSTEM_OPERATIONS_COMMITTED_NOT_FINALIZED" : "PARTIAL_PROGRESS";
        return new { version = 5, scope = "MIXED_JOURNAL_ONLY_NOT_VERIFIED_PUBLICATION", transactionId = id,
          projectIdentity = header["projectIdentity"], draftId = header["draftId"], draftVersion = header["draftVersion"],
          verifiedDigest = header["verifiedDigest"], baseDigest = header["baseDigest"], phase = last["phase"], sequence = last["sequence"],
          operationIndex = last["operationIndex"], operations = header["operations"], operationStates = states,
          journalRecordedCommits = states.Where(state => new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "FINALIZED", "CLEANUP_STARTED", "CLEANED" }.Contains(state.durablePhase))
            .Select(state => state.destinationPath).ToArray(), journalPendingOperations = states.Length - committed,
          journalState, filesystemState = observedFilesystemState, recoveryState = recovery,
          terminalObservation = last.ContainsKey("terminalObservation") ? last["terminalObservation"] : null, cleanup = "NOT_PROVEN",
          projectPublished = false };
      }
      if ((int)header["version"] >= 2) return new { version = (int)header["version"], scope = (int)header["version"] == 6 ? "SINGLE_FILE_CREATE_JOURNAL_NOT_CONTROLLER_PUBLICATION" : (int)header["version"] == 4 ? "SINGLE_FILE_RENAME_JOURNAL_NOT_CONTROLLER_PUBLICATION" : (int)header["version"] == 3 ? "SINGLE_FILE_DELETE_JOURNAL_NOT_CONTROLLER_PUBLICATION" : "SINGLE_FILE_MODIFY_JOURNAL_NOT_CONTROLLER_PUBLICATION", transactionId = id,
        projectIdentity = header["projectIdentity"], draftId = header["draftId"], draftVersion = header["draftVersion"], verifiedDigest = header["verifiedDigest"], baseDigest = header["baseDigest"],
        phase = last["phase"], sequence = last["sequence"], operationIndex = last["operationIndex"], operations = header["operations"], tempIdentity = last["tempIdentity"], committedIdentity = last["committedIdentity"],
        filesCommitted = last["committedIdentity"] == null ? new string[0] : new string[] { (string)((Dictionary<string, object>)Operations(header)[0])["path"] },
        pendingOperations = last["committedIdentity"] == null ? 1 : 0, recoveryState = recovery, cleanup = (string)last["phase"] == "CLEANED" ? "PASS" : "NOT_PROVEN", projectPublished = false };
      return new { version = 1, scope = "DURABLE_JOURNAL_NOT_PROJECT_PUBLICATION", transactionId = id, projectIdentity = header["projectIdentity"], draftId = header["draftId"], draftVersion = header["draftVersion"], verifiedDigest = header["verifiedDigest"], baseDigest = header["baseDigest"],
        phase = last["phase"], sequence = last["sequence"], operationIndex = last["operationIndex"], operations = header["operations"], tempIdentity = last["tempIdentity"], committedIdentity = last["committedIdentity"],
        filesCommitted = new string[0], pendingOperations = Operations(header).Count, recoveryState = recovery, cleanup = "NOT_PERFORMED", projectPublished = false };
    }
    object InspectMixedPhysical(Action<string> trace = null) {
      if ((int)header["version"] != 5 || mixedPhases == null || mixedPhases.Length != 4) throw new InvalidDataException();
      var evidence = new List<object>(); int newCount = 0; bool conflict = false, uncertain = false;
      bool quarantineAbsent = false, verifiedDraftDigestMatched = false;
      for (int index = 0; index < mixedPhases.Length; index++) {
        if (trace != null) trace("OP" + index.ToString() + "_START");
        Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[index];
        string kind = (string)op["kind"], phase = mixedPhases[index], path = (string)op["path"];
        string[] destinationParts = AnchoredFile.Segments(path);
        string destinationPath = destinationParts.Aggregate(project, (current, part) => Path.Combine(current, part));
        DeleteObject destination, source = null, quarantine = null, createTemp = null;
        using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(destinationPath))) {
          destination = ReadDeleteLeaf(parent, destinationParts.Last());
          if (kind == "RENAME") source = ReadDeleteLeaf(parent, AnchoredFile.Segments((string)op["sourcePath"]).Last());
        if (kind == "DELETE") { quarantine = ReadDeleteLeaf(parent, DeleteLeaf(id)); quarantineAbsent = quarantine == null; }
          if (kind == "CREATE") createTemp = ReadDeleteLeaf(parent, "phi-publish-" + id + ".tmp");
        }
        bool baseAtDestination = DeleteBaseMatches(destination, op);
        bool resultAtDestination = destination != null && destination.Digest == (string)op["newDigest"] &&
          destination.Bytes == (int)(op["newBytes"] ?? -1) &&
          (kind == "CREATE" ? mixedTempIdentities[index] != null && destination.Identity == mixedTempIdentities[index] :
            destination.Identity == (string)op["baseIdentity"]);
        string physical;
        if (kind == "REPLACE") physical = baseAtDestination ? "OLD_COMPLETE_OBSERVED" : resultAtDestination ? "NEW_COMPLETE_OBSERVED" : "CONFLICT";
        else if (kind == "CREATE") physical = destination == null && createTemp == null && mixedTempIdentities[index] == null ? "OLD_COMPLETE_OBSERVED" :
          destination == null && createTemp != null ? createTemp.Identity == mixedTempIdentities[index] &&
            createTemp.Digest == (string)op["newDigest"] && createTemp.Bytes == (int)op["newBytes"] ? "STAGED_COMPLETE_OBSERVED" : "UNVERIFIED" :
          destination == null ? "UNVERIFIED" : createTemp != null ? "CONFLICT" : resultAtDestination ? "NEW_COMPLETE_OBSERVED" : "CONFLICT";
        else if (kind == "DELETE") {
          bool cleanupIntent = new string[] { "CLEANUP_STARTED", "CLEANED" }.Contains((string)last["phase"]) &&
            mixedCommittedIdentities[index] == (string)op["baseIdentity"];
          physical = baseAtDestination && quarantine == null ? "OLD_COMPLETE_OBSERVED" :
            destination == null && DeleteBaseMatches(quarantine, op) ? "NEW_COMPLETE_OBSERVED" :
            destination == null && quarantine == null && cleanupIntent ? "NEW_COMPLETE_OBSERVED" :
            destination == null && quarantine == null ? "UNVERIFIED" : "CONFLICT";
        }
        else {
          bool sourceExpected = DeleteBaseMatches(source, op) && source.Bytes == (int)op["newBytes"];
          physical = sourceExpected && destination == null ? "OLD_COMPLETE_OBSERVED" :
            source == null && resultAtDestination ? "NEW_COMPLETE_OBSERVED" :
            source == null && destination == null ? "UNVERIFIED" : "CONFLICT";
        }
        bool recordedCommit = new string[] { "COMMITTED", "POST_COMMIT_VERIFIED", "FINALIZED", "CLEANUP_STARTED", "CLEANED" }.Contains(phase);
        if (recordedCommit && physical != "NEW_COMPLETE_OBSERVED" || phase == "NOT_STARTED" && physical != "OLD_COMPLETE_OBSERVED")
          physical = physical == "UNVERIFIED" || physical == "STAGED_COMPLETE_OBSERVED" ? "UNVERIFIED" : "CONFLICT";
        if (physical == "NEW_COMPLETE_OBSERVED" && (phase == "PREPARED" || phase == "NOT_STARTED")) physical = "CONFLICT";
        if (physical == "NEW_COMPLETE_OBSERVED") newCount++;
        if (physical == "CONFLICT") conflict = true;
        if (physical == "UNVERIFIED" || physical == "STAGED_COMPLETE_OBSERVED") uncertain = true;
        evidence.Add(new { operationIndex = index, kind, durablePhase = phase, physicalState = physical,
          recordedTempIdentity = mixedTempIdentities[index], recordedCommittedIdentity = mixedCommittedIdentities[index],
          observedDestinationIdentity = destination == null ? null : destination.Identity,
          observedDestinationDigest = destination == null ? null : destination.Digest,
          observedSourceIdentity = source == null ? null : source.Identity,
          observedSourceDigest = source == null ? null : source.Digest,
          observedQuarantineIdentity = quarantine == null ? null : quarantine.Identity,
          observedQuarantineDigest = quarantine == null ? null : quarantine.Digest,
          observedCreateTempIdentity = createTemp == null ? null : createTemp.Identity,
          observedCreateTempDigest = createTemp == null ? null : createTemp.Digest });
        if (trace != null) trace("OP" + index.ToString() + "_DONE");
      }
      // An absent quarantine after durable cleanup intent is meaningful only
      // alongside the complete verified draft. A per-file absence is not by
      // itself proof of a successful DELETE or whole-project publication.
      if (!conflict && !uncertain && newCount == mixedPhases.Length) {
        try {
          Dictionary<string, object> deletion = (Dictionary<string, object>)Operations(header)[2];
          string[] parts = AnchoredFile.Segments((string)deletion["path"]);
          string quarantinePath = String.Join("/", parts.Take(parts.Length - 1).Concat(new string[] { DeleteLeaf(id) }));
          string expected = (string)last["phase"] == "CLEANED" ? null : quarantinePath;
          Dictionary<string, object> snapshot = Snapshot(project, (string)header["projectIdentity"], expected);
          verifiedDraftDigestMatched = ProjectDraftDigest((Dictionary<string, object>)snapshot["files"]) == (string)header["verifiedDigest"];
          if (!verifiedDraftDigestMatched) conflict = true;
        } catch { uncertain = true; }
      }
      string filesystemState = conflict ? "CONFLICT" : uncertain ? "MANUAL_RECOVERY_REQUIRED" : newCount == 0 ? "NONE_COMMITTED" :
        newCount == mixedPhases.Length ? "ALL_MUTATIONS_COMMITTED" : "PARTIALLY_COMMITTED";
      bool terminalObserved = !conflict && !uncertain && newCount == mixedPhases.Length &&
        quarantineAbsent && verifiedDraftDigestMatched &&
        new string[] { "CLEANUP_STARTED", "CLEANED" }.Contains((string)last["phase"]);
      string status = conflict ? "CONFLICT" : terminalObserved ? "NEW_COMPLETE_OBSERVED" : "UNKNOWN_FAIL_SAFE";
      // No individual V5 operation authorizes recovery by itself. The only
      // automatic cell is the full, fresh, quarantine-absent terminal physical
      // observation after durable cleanup intent (R1); all other combinations
      // deliberately remain manual. A prior CLEANED is retained, not replayed.
      string recoveryDisposition = terminalObserved ?
        (string)last["phase"] == "CLEANUP_STARTED" ? "OBSERVE_FINALIZE_METADATA_ONLY" : "TERMINAL_RETAINED" :
        "FAIL_CLOSED_MANUAL";
      return new { status, metadata = Metadata(status == "CONFLICT" ? "CONFLICT" : terminalObserved ?
          (string)last["phase"] == "CLEANED" ? "TERMINAL_RETAINED" : "RECOVERY_REQUIRED" : "MANUAL_RECOVERY_REQUIRED", filesystemState),
        operationEvidence = evidence, filesystemState, quarantineAbsent, verifiedDraftDigestMatched, recoveryDisposition,
        ownerGenerationAlive = false, projectMutations = 0,
        journalMutations = 0, processKills = 0, projectPublished = false };
    }
    internal static object Inspect(string transactionId, string project, string expectedProjectIdentity, bool recover = false, Action<string> trace = null) {
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
              if ((int)parsed.header["version"] == 6) {
                if (recover) throw new InvalidDataException();
                return parsed.InspectSingleCreate();
              }
              if ((int)parsed.header["version"] == 5) {
                if (recover) throw new InvalidDataException();
                // Physical evidence is read-only. No V5 recovery action or
                // publication grant exists yet, even when all bytes match.
                return parsed.InspectMixedPhysical(trace);
              }
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
    internal static int DiscoverProjectTransactions(Stream input) {
      // Read-only advisory inventory. Admission serializes the private index
      // snapshot against Begin; each selected journal is independently read
      // and revalidated by Inspect. Nothing here supplies recovery authority.
      try {
        Dictionary<string, object> request;
        using (MemoryStream line = new MemoryStream()) {
          bool complete = false;
          for (int i = 0; i < MaxBytes; i++) { int next = input.ReadByte(); if (next < 0) throw new InvalidDataException();
            if (next == 10) { complete = true; break; } line.WriteByte((byte)next); }
          if (!complete) throw new InvalidDataException();
          request = Serializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(line.ToArray()));
        }
        Keys(request, "version", "root"); Number(request, "version", 1, 1);
        string project = request["root"] as string;
        if (project == null || project.Length > 1024 || project.IndexOf('\0') >= 0 || !Path.IsPathRooted(project)) throw new InvalidDataException();
        string rootIdentity;
        using (RecoveryFilesystem pinned = new RecoveryFilesystem(project)) rootIdentity = RecoveryFilesystem.HandleIdentity(pinned.DirectoryHandle);
        List<Tuple<string, int>> selected = new List<Tuple<string, int>>(); int scanned = 0;
        using (Mutex admission = Lease(new string('0', 32), true)) {
          if (!Acquire(admission, 1000)) throw new InvalidDataException();
          try {
            using (RegistryKey root = Registry.CurrentUser.OpenSubKey(RegistryBase, false)) {
              if (root != null) {
                ScopeRecovery.ValidateRegistry(root);
                string[] names = root.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).ToArray();
                if (names.Length > MaxTransactions) throw new InvalidDataException();
                scanned = names.Length;
                foreach (string tx in names) {
                  if (!Id.IsMatch(tx)) throw new InvalidDataException();
                  using (RegistryKey key = root.OpenSubKey(tx, false)) {
                    if (key == null) throw new InvalidDataException(); ScopeRecovery.ValidateRegistry(key);
                    Dictionary<string, object> first = Decode(ReadValue(key, "E00000000"));
                    Keys(first, "sequence", "previousDigest", "phase", "operationIndex", "tempIdentity", "committedIdentity", "header");
                    if (Number(first, "sequence", 0, 0) != 0 || (string)first["previousDigest"] != new string('0', 64) ||
                        (string)first["phase"] != "PREPARED" || Number(first, "operationIndex", 0, 0) != 0 ||
                        first["tempIdentity"] != null || first["committedIdentity"] != null) throw new InvalidDataException();
                    Dictionary<string, object> header = first["header"] as Dictionary<string, object>; ValidateHeader(header, tx);
                    if ((string)header["projectIdentity"] == rootIdentity) selected.Add(Tuple.Create(tx, (int)header["version"]));
                  }
                }
              }
            }
          } finally { admission.ReleaseMutex(); }
        }
        var entries = new List<object>();
        foreach (Tuple<string, int> item in selected) {
          Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(Inspect(item.Item1, project, rootIdentity, false)));
          if ((int)observed["projectMutations"] != 0 || (int)observed["journalMutations"] != 0 ||
              (int)observed["processKills"] != 0 || (bool)observed["projectPublished"]) throw new InvalidDataException();
          string status = observed["status"] as string;
          bool active = status == "ACTIVE";
          Dictionary<string, object> metadata = active ? null : observed["metadata"] as Dictionary<string, object>;
          if (!active && (metadata == null || (string)metadata["transactionId"] != item.Item1 ||
              (string)metadata["projectIdentity"] != rootIdentity || (int)metadata["version"] != item.Item2 ||
              (bool)metadata["projectPublished"])) throw new InvalidDataException();
          if (!new string[] { "ACTIVE", "OLD_COMPLETE_OBSERVED", "NEW_COMPLETE_OBSERVED", "DELETE_COMMITTED_QUARANTINE_RETAINED",
              "DELETE_COMMITTED_CLEANUP_OBSERVED", "RENAME_COMMITTED_DESTINATION_RETAINED", "CONFLICT", "UNKNOWN_FAIL_SAFE", "RECOVERY_REQUIRED" }.Contains(status)) throw new InvalidDataException();
          string phase = active ? "UNKNOWN_ACTIVE" : (string)metadata["phase"];
          string classification = active ? "ACTIVE_UNVERIFIED" : status == "CONFLICT" ? "CONFLICT" :
            status == "UNKNOWN_FAIL_SAFE" ? "MANUAL_RECOVERY_REQUIRED" :
            new string[] { "CLEANED", "ROLLED_BACK" }.Contains(phase) ? "TERMINAL_RETAINED" : "RECOVERY_REQUIRED";
          entries.Add(new { transactionId = item.Item1, journalVersion = item.Item2, phase, observedStatus = status, classification });
        }
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "PASS_READ_ONLY_DISCOVERY", rootIdentity,
          rootIdentityVerified = true, scannedTransactions = scanned, projectTransactions = entries.Count, entries,
          actionPerformed = false, journalMutations = 0, projectMutations = 0, processKills = 0, projectPublished = false, externalRequests = 0 }));
        return 0;
      } catch {
        // Never emit a partial list that a restarted controller might mistake
        // for a complete, clean project inventory.
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_READ_ONLY_DISCOVERY", decision = "UNKNOWN_FAIL_SAFE",
          actionPerformed = false, journalMutations = 0, projectMutations = 0, processKills = 0, projectPublished = false, externalRequests = 0 }));
        return 70;
      }
    }
    static string JsonString(string value) {
      // Match JSON.stringify for a valid UTF-8 project snapshot. This is used
      // only for digest comparison; file contents never enter a receipt/journal.
      StringBuilder result = new StringBuilder("\"");
      foreach (char c in value) {
        if (c == '\"' || c == '\\') { result.Append('\\'); result.Append(c); }
        else if (c == '\b') result.Append("\\b");
        else if (c == '\f') result.Append("\\f");
        else if (c == '\n') result.Append("\\n");
        else if (c == '\r') result.Append("\\r");
        else if (c == '\t') result.Append("\\t");
        else if (c < 0x20) result.Append("\\u").Append(((int)c).ToString("x4"));
        else result.Append(c);
      }
      return result.Append('\"').ToString();
    }
    static string ProjectBaseDigest(string rootIdentity, Dictionary<string, object> files, Dictionary<string, object> identities) {
      if (files.Count != identities.Count) throw new InvalidDataException();
      StringBuilder json = new StringBuilder("{\"rootIdentity\":").Append(JsonString(rootIdentity)).Append(",\"files\":{");
      bool first = true;
      foreach (string name in files.Keys.OrderBy(x => x, StringComparer.Ordinal)) {
        if (!identities.ContainsKey(name) || !(files[name] is string) || !(identities[name] is string)) throw new InvalidDataException();
        if (!first) json.Append(','); first = false;
        string value = (string)files[name];
        json.Append(JsonString(name)).Append(":{\"identity\":").Append(JsonString((string)identities[name]))
          .Append(",\"digest\":").Append(JsonString(Hash(Encoding.UTF8.GetBytes(value))))
          .Append(",\"bytes\":").Append(Encoding.UTF8.GetByteCount(value)).Append('}');
      }
      return Hash(Encoding.UTF8.GetBytes(json.Append("}}").ToString()));
    }
    static string ProjectBaseDigestWithRestoredDelete(string rootIdentity, Dictionary<string, object> files,
        Dictionary<string, object> identities, string source, DeleteObject held) {
      // Compute the canonical pre-delete aggregate without reading a reserved
      // quarantine through the ordinary project snapshot. The exact held
      // object's identity/digest/length are checked against the journal first.
      if (files.Count != identities.Count || files.ContainsKey(source) || identities.ContainsKey(source)) throw new InvalidDataException();
      StringBuilder json = new StringBuilder("{\"rootIdentity\":").Append(JsonString(rootIdentity)).Append(",\"files\":{");
      bool first = true;
      foreach (string name in files.Keys.Concat(new string[] { source }).OrderBy(x => x, StringComparer.Ordinal)) {
        if (!first) json.Append(','); first = false;
        string identity, digest; long bytes;
        if (name == source) { identity = held.Identity; digest = held.Digest; bytes = held.Bytes; }
        else {
          if (!identities.ContainsKey(name) || !(files[name] is string) || !(identities[name] is string)) throw new InvalidDataException();
          string value = (string)files[name]; identity = (string)identities[name]; digest = Hash(Encoding.UTF8.GetBytes(value)); bytes = Encoding.UTF8.GetByteCount(value);
        }
        json.Append(JsonString(name)).Append(":{\"identity\":").Append(JsonString(identity))
          .Append(",\"digest\":").Append(JsonString(digest)).Append(",\"bytes\":").Append(bytes).Append('}');
      }
      return Hash(Encoding.UTF8.GetBytes(json.Append("}}").ToString()));
    }
    static string ProjectDraftDigest(Dictionary<string, object> files) {
      StringBuilder json = new StringBuilder("["); bool first = true;
      foreach (string name in files.Keys.OrderBy(x => x, StringComparer.Ordinal)) {
        if (!(files[name] is string)) throw new InvalidDataException();
        if (!first) json.Append(','); first = false;
        json.Append('[').Append(JsonString(name)).Append(',').Append(JsonString((string)files[name])).Append(']');
      }
      return Hash(Encoding.UTF8.GetBytes(json.Append(']').ToString()));
    }
    bool VerifiedRenameSnapshot(Dictionary<string, object> snapshot, bool alreadyRenamed) {
      if ((int)header["version"] != 4 || (string)snapshot["rootIdentity"] != (string)header["projectIdentity"]) return false;
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string source = (string)op["sourcePath"], target = (string)op["path"];
      Dictionary<string, object> actualFiles = (Dictionary<string, object>)snapshot["files"], actualIds = (Dictionary<string, object>)snapshot["identities"];
      string present = alreadyRenamed ? target : source, absent = alreadyRenamed ? source : target;
      if (!actualFiles.ContainsKey(present) || actualFiles.ContainsKey(absent) || !actualIds.ContainsKey(present) ||
          (string)actualIds[present] != (string)op["baseIdentity"] ||
          Hash(Encoding.UTF8.GetBytes((string)actualFiles[present])) != (string)op["baseDigest"] ||
          Encoding.UTF8.GetByteCount((string)actualFiles[present]) != (int)op["newBytes"]) return false;
      Dictionary<string, object> baseFiles = new Dictionary<string, object>(actualFiles), baseIds = new Dictionary<string, object>(actualIds);
      Dictionary<string, object> draftFiles = new Dictionary<string, object>(actualFiles);
      if (alreadyRenamed) {
        baseFiles.Remove(target); baseIds.Remove(target);
        baseFiles.Add(source, actualFiles[target]); baseIds.Add(source, actualIds[target]);
      } else {
        draftFiles.Remove(source); draftFiles.Add(target, actualFiles[source]);
      }
      return ProjectBaseDigest((string)header["projectIdentity"], baseFiles, baseIds) == (string)header["baseDigest"] &&
        ProjectDraftDigest(draftFiles) == (string)header["verifiedDigest"];
    }
    bool VerifiedDeleteSnapshot(string expectedRootIdentity, DeleteObject quarantine) {
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      if (!DeleteBaseMatches(quarantine, op)) return false;
      string[] parts = AnchoredFile.Segments((string)op["path"]);
      string excluded = String.Join("/", parts.Take(parts.Length - 1).Concat(new string[] { DeleteLeaf(id) }));
      Dictionary<string, object> snapshot = Snapshot(project, expectedRootIdentity, excluded);
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"], identities = (Dictionary<string, object>)snapshot["identities"];
      return !files.ContainsKey((string)op["path"]) &&
        ProjectBaseDigestWithRestoredDelete(expectedRootIdentity, files, identities, (string)op["path"], quarantine) == (string)header["baseDigest"] &&
        ProjectDraftDigest(files) == (string)header["verifiedDigest"];
    }
    object RecoverKnownModify(string expectedRootIdentity, Action live) {
      // A dead V2 publisher's private proof is gone. The complete base tree
      // can justify only a journal rollback before a recorded commit. A
      // complete new tree cannot reconstruct its ACL/creation-time proof, so
      // an incomplete commit remains manual even if its bytes match the draft.
      string before = (string)last["phase"];
      int sequence = (int)last["sequence"];
      Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(InspectSingleModify(false)));
      string status = observed["status"] as string;
      bool baseVerified = false, draftVerified = false;
      string decision = status == "CONFLICT" ? "CONFLICT" : "MANUAL_RECOVERY_REQUIRED";
      if (status == "OLD_COMPLETE_OBSERVED" || status == "NEW_COMPLETE_OBSERVED") {
        Dictionary<string, object> snapshot = Snapshot(project, expectedRootIdentity);
        Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"];
        if (status == "OLD_COMPLETE_OBSERVED") {
          baseVerified = ProjectBaseDigest(expectedRootIdentity, files,
            (Dictionary<string, object>)snapshot["identities"]) == (string)header["baseDigest"];
          if (!baseVerified) decision = "CONFLICT";
          else if (before == "ROLLED_BACK") decision = "CLEANUP_ONLY";
          else if (new string[] { "PREPARED", "TEMP_CREATED", "TEMP_WRITTEN", "TEMP_FLUSHED", "READY_TO_COMMIT", "COMMIT_STARTED", "ROLLBACK_REQUIRED" }.Contains(before)) {
            decision = "ROLLBACK";
            live();
            if (before != "ROLLBACK_REQUIRED") Observe("ROLLBACK_REQUIRED", last["tempIdentity"] as string, null);
            live();
            Observe("ROLLED_BACK", last["tempIdentity"] as string, null);
          }
        } else {
          draftVerified = ProjectDraftDigest(files) == (string)header["verifiedDigest"];
          if (!draftVerified) decision = "CONFLICT";
          else if (before == "CLEANED") decision = "CLEANUP_ONLY";
        }
      }
      return new { version = 1, status = "PASS_BOUNDED_MODIFY_RECOVERY", transactionId = id, rootIdentity = expectedRootIdentity,
        rootIdentityVerified = true, observedStatus = status, decision, phaseBefore = before, phaseAfter = last["phase"],
        baseDigestVerified = baseVerified, verifiedDraftDigestMatched = draftVerified,
        actionPerformed = (int)last["sequence"] != sequence, journalMutations = (int)last["sequence"] - sequence,
        projectMutations = 0, processKills = 0, projectPublished = false, externalRequests = 0 };
    }
    object RecoverKnownDelete(string expectedRootIdentity, Action live) {
      string before = (string)last["phase"]; int sequence = (int)last["sequence"];
      Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(InspectSingleDelete(false)));
      string status = observed["status"] as string;
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      string[] parts = AnchoredFile.Segments((string)op["path"]);
      string path = parts.Aggregate(project, (current, part) => Path.Combine(current, part));
      string quarantineName = DeleteLeaf(id), expected = (string)op["baseIdentity"];
      string decision = status == "CONFLICT" ? "CONFLICT" : "MANUAL_RECOVERY_REQUIRED";
      bool wholeVerified = false, baseVerified = false, draftVerified = false;
      using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(path))) {
        DeleteObject current = ReadDeleteLeaf(parent, parts.Last()), quarantined = ReadDeleteLeaf(parent, quarantineName);
        if (status == "OLD_COMPLETE_OBSERVED" && DeleteBaseMatches(current, op) && quarantined == null) {
          Dictionary<string, object> snapshot = Snapshot(project, expectedRootIdentity);
          Dictionary<string, object> actualFiles = (Dictionary<string, object>)snapshot["files"];
          Dictionary<string, object> expectedDraft = new Dictionary<string, object>(actualFiles); expectedDraft.Remove((string)op["path"]);
          baseVerified = ProjectBaseDigest(expectedRootIdentity, actualFiles,
            (Dictionary<string, object>)snapshot["identities"]) == (string)header["baseDigest"];
          draftVerified = ProjectDraftDigest(expectedDraft) == (string)header["verifiedDigest"];
          wholeVerified = baseVerified && draftVerified;
          if (!wholeVerified) decision = "CONFLICT";
          else if (before == "ROLLED_BACK") decision = "CLEANUP_ONLY";
          else if (new string[] { "PREPARED", "DELETE_INTENT", "ROLLBACK_REQUIRED" }.Contains(before)) {
            decision = "ROLLBACK";
            if (before != "ROLLBACK_REQUIRED") Observe("ROLLBACK_REQUIRED", last["tempIdentity"] as string, null);
            Observe("ROLLED_BACK", last["tempIdentity"] as string, null);
          }
        } else if (status == "DELETE_COMMITTED_QUARANTINE_RETAINED" && current == null && DeleteBaseMatches(quarantined, op)) {
          // A transaction-derived quarantine with a matching ID/hash is not
          // enough: the entire unchanged project must match both durable
          // base and verified-draft aggregate digests.
          wholeVerified = VerifiedDeleteSnapshot(expectedRootIdentity, quarantined);
          baseVerified = draftVerified = wholeVerified;
          if (!wholeVerified) decision = "CONFLICT";
          else if (new string[] { "DELETE_INTENT", "DELETE_QUARANTINED", "ROLLBACK_REQUIRED" }.Contains(before) && last["committedIdentity"] == null) {
            IntPtr held = IntPtr.Zero;
            try {
              RecoveryFilesystem.Info info; held = parent.OpenDeleteSource(quarantineName, out info);
              if (!DeleteBaseMatches(ReadDeleteObject(held), op) || ReadDeleteLeaf(parent, parts.Last()) != null ||
                  !VerifiedDeleteSnapshot(expectedRootIdentity, ReadDeleteObject(held))) throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
              if (before != "ROLLBACK_REQUIRED") Observe("ROLLBACK_REQUIRED", expected, null);
              live(); recoveryMutationUncertain = true;
              parent.RestoreOwnedQuarantine(held, quarantineName, parts.Last(), expected, (string)op["baseDigest"]);
              recoveryProjectMutations = 1; live();
            } finally { CloseNative(held); }
            Dictionary<string, object> restored = Snapshot(project, expectedRootIdentity);
            if (ProjectBaseDigest(expectedRootIdentity, (Dictionary<string, object>)restored["files"],
                (Dictionary<string, object>)restored["identities"]) != (string)header["baseDigest"] ||
                ReadDeleteLeaf(parent, quarantineName) != null) throw new InvalidDataException();
            recoveryMutationUncertain = false;
            Observe("ROLLED_BACK", expected, null); decision = "ROLLBACK";
          }
        } else if (status == "DELETE_COMMITTED_CLEANUP_OBSERVED" && current == null && quarantined == null) {
          Dictionary<string, object> snapshot = Snapshot(project, expectedRootIdentity);
          draftVerified = ProjectDraftDigest((Dictionary<string, object>)snapshot["files"]) == (string)header["verifiedDigest"];
          wholeVerified = draftVerified;
          if (!wholeVerified) decision = "CONFLICT";
          else if (before == "CLEANED") decision = "CLEANUP_ONLY";
          else if (before == "CLEANUP_STARTED" || before == "RECOVERY_REQUIRED") {
            Observe("CLEANED", expected, expected); decision = "FINALIZE_COMMIT";
          }
        }
      }
      // A proven conflict is durable evidence, not authority to remove the
      // quarantine or overwrite a newer project object. Terminal records are
      // immutable; repeated inspection of them remains read-only.
      if (decision == "CONFLICT" && !new string[] { "CONFLICT", "CLEANED", "ROLLED_BACK", "FAILED" }.Contains((string)last["phase"]))
        Observe("CONFLICT", last["tempIdentity"] as string, last["committedIdentity"] as string);
      return new { version = 1, status = "PASS_BOUNDED_DELETE_RECOVERY", transactionId = id, rootIdentity = expectedRootIdentity,
        rootIdentityVerified = true, observedStatus = status, decision, phaseBefore = before, phaseAfter = last["phase"],
        baseDigestVerified = baseVerified, verifiedDraftDigestMatched = draftVerified,
        actionPerformed = (int)last["sequence"] != sequence || recoveryProjectMutations != 0,
        journalMutations = (int)last["sequence"] - sequence, projectMutations = recoveryProjectMutations,
        processKills = 0, projectPublished = false, externalRequests = 0 };
    }
    object RecoverKnownRename(string expectedRootIdentity, Action live) {
      // Called only after a dead creator and a complete, private, pinned journal
      // have been validated under this transaction's exclusive lease. Only a
      // flushed RENAME_INTENT can authorize the exact pending no-clobber move;
      // no recovered state can grant general publication authority.
      string before = (string)last["phase"];
      int sequence = (int)last["sequence"];
      object inspected = InspectSingleRename(false);
      Dictionary<string, object> observation = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(inspected));
      string observed = observation["status"] as string;
      bool old = observed == "OLD_COMPLETE_OBSERVED", next = observed == "RENAME_COMMITTED_DESTINATION_RETAINED";
      bool wholeVerified = (old || next) && VerifiedRenameSnapshot(Snapshot(project, expectedRootIdentity), next);
      string decision = observed == "CONFLICT" || (old || next) && !wholeVerified ? "CONFLICT" : "MANUAL_RECOVERY_REQUIRED";
      if (wholeVerified && old && before == "RENAME_INTENT") {
        // Durable INTENT is a recovery-only capability for this exact bounded
        // move. The verified new bytes still exist in the expected source.
        // PREPARED alone cannot authorize this project mutation.
        Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
        string[] sourceParts = AnchoredFile.Segments((string)op["sourcePath"]), targetParts = AnchoredFile.Segments((string)op["path"]);
        string sourcePath = sourceParts.Aggregate(project, (current, part) => Path.Combine(current, part));
        using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(sourcePath))) {
          IntPtr source = IntPtr.Zero;
          try {
            RecoveryFilesystem.Info info; source = parent.OpenRenameSource(sourceParts.Last(), out info);
            DeleteObject held = ReadDeleteObject(source);
            if (!DeleteBaseMatches(held, op) || held.Bytes != (int)op["newBytes"] || ReadDeleteLeaf(parent, targetParts.Last()) != null)
              throw new InvalidOperationException("PHI_PUBLICATION_CONFLICT");
            live(); recoveryMutationUncertain = true;
            parent.RenameExpectedSource(source, sourceParts.Last(), targetParts.Last(), (string)op["baseIdentity"], (string)op["baseDigest"]);
            recoveryProjectMutations = 1;
            live();
          } finally { CloseNative(source); }
        }
        // Never finalize a project mutation if the complete verified draft is
        // no longer the actual project. A failure retains the intent/evidence.
        if (!VerifiedRenameSnapshot(Snapshot(project, expectedRootIdentity), true)) throw new InvalidDataException();
        recoveryMutationUncertain = false;
        old = false; next = true; decision = "RESUME";
      }
      if (wholeVerified && old && before == "PREPARED") {
        decision = "ROLLBACK";
        Observe("ROLLBACK_REQUIRED", last["tempIdentity"] as string, null);
        Observe("ROLLED_BACK", last["tempIdentity"] as string, null);
      } else if (wholeVerified && next && new string[] { "RENAME_INTENT", "RENAMED", "COMMITTED", "POST_COMMIT_VERIFIED", "RECOVERY_REQUIRED" }.Contains(before)) {
        if (decision != "RESUME") decision = before == "RENAME_INTENT" || before == "RENAMED" ? "RESUME" : "FINALIZE_COMMIT";
        string expected = (string)((Dictionary<string, object>)Operations(header)[0])["baseIdentity"];
        if ((string)last["phase"] == "RENAME_INTENT") Observe("RENAMED", expected, null);
        if ((string)last["phase"] == "RENAMED") Observe("COMMITTED", expected, expected);
        if ((string)last["phase"] == "COMMITTED") Observe("POST_COMMIT_VERIFIED", expected, expected);
        Observe("CLEANED", expected, expected);
      } else if (wholeVerified && (old && before == "ROLLED_BACK" || next && before == "CLEANED")) decision = "CLEANUP_ONLY";
      // Only a durable INTENT plus exact held source permits one no-clobber
      // project rename. All other recovery decisions are metadata-only.
      return new { version = 1, status = "PASS_BOUNDED_RENAME_RECOVERY", transactionId = id, rootIdentity = expectedRootIdentity,
        rootIdentityVerified = true, observedStatus = observed, decision, phaseBefore = before, phaseAfter = last["phase"],
        baseDigestVerified = wholeVerified, verifiedDraftDigestMatched = wholeVerified,
        actionPerformed = (int)last["sequence"] != sequence || recoveryProjectMutations != 0, journalMutations = (int)last["sequence"] - sequence,
        projectMutations = recoveryProjectMutations, processKills = 0, projectPublished = false, externalRequests = 0 };
    }
    object RecoverKnownMixed(string expectedRootIdentity, Action live, Action afterObservation = null) {
      if ((int)header["version"] != 5 || (string)header["projectIdentity"] != expectedRootIdentity ||
          (string)last["phase"] != "CLEANUP_STARTED" || (int)last["operationIndex"] != 3 ||
          mixedPhases == null || !mixedPhases.SequenceEqual(new string[] { "FINALIZED", "FINALIZED", "FINALIZED", "CLEANUP_STARTED" }))
        throw new InvalidDataException();
      live();
      Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(InspectMixedPhysical()));
      IList physical = observed["operationEvidence"] as IList;
      if ((string)observed["status"] != "NEW_COMPLETE_OBSERVED" ||
          (string)observed["filesystemState"] != "ALL_MUTATIONS_COMMITTED" ||
          (string)observed["recoveryDisposition"] != "OBSERVE_FINALIZE_METADATA_ONLY" ||
          !(bool)observed["quarantineAbsent"] || !(bool)observed["verifiedDraftDigestMatched"] ||
          physical == null || physical.Count != 4 || physical.Cast<Dictionary<string, object>>().Any(item =>
            (string)item["physicalState"] != "NEW_COMPLETE_OBSERVED")) throw new InvalidDataException();
      // The fixture callback may change the filesystem here. The record
      // attests only the completed observation, never continuous exclusion.
      if (afterObservation != null) afterObservation();
      live();
      ObserveMixed(3, "CLEANED", mixedTempIdentities[3], mixedCommittedIdentities[3], RecoveryTerminalObservation);
      return new { version = 1, status = "PASS_BOUNDED_MIXED_TERMINAL_OBSERVATION", transactionId = id,
        rootIdentity = expectedRootIdentity, rootIdentityVerified = true, observedStatus = "NEW_COMPLETE_OBSERVED",
        decision = "RECORD_TERMINAL_OBSERVATION", phaseBefore = "CLEANUP_STARTED", phaseAfter = "CLEANED",
        terminalObservation = RecoveryTerminalObservation, quarantineAbsent = true, verifiedDraftDigestMatched = true,
        cleanup = "NOT_PROVEN", actionPerformed = true, journalMutations = 1, projectMutations = 0,
        processKills = 0, projectPublished = false, externalRequests = 0 };
    }
    internal static int RecoverKnownTransaction(Stream input) {
      PublicationJournal journal = null;
      try {
        Dictionary<string, object> request;
        using (MemoryStream line = new MemoryStream()) {
          bool complete = false;
          for (int i = 0; i < MaxBytes; i++) { int next = input.ReadByte(); if (next < 0) throw new InvalidDataException();
            if (next == 10) { complete = true; break; } line.WriteByte((byte)next); }
          if (!complete) throw new InvalidDataException();
          request = Serializer().Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(line.ToArray()));
        }
        Keys(request, "version", "root", "transactionId", "guardianPid", "timeoutMs"); Number(request, "version", 1, 1);
        string project = request["root"] as string, tx = StringField(request, "transactionId", Id);
        if (project == null || project.Length > 1024 || project.IndexOf('\0') >= 0 || !Path.IsPathRooted(project)) throw new InvalidDataException();
        object result = null;
        OwnedProcess.WithPublicationGuardian(Number(request, "guardianPid", 1, Int32.MaxValue), Number(request, "timeoutMs", 1, 15000), delegate(Action live) {
          journal = new PublicationJournal(tx, project);
          string rootIdentity = RecoveryFilesystem.HandleIdentity(journal.pins.DirectoryHandle);
          using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx, false)) {
            if (key == null) throw new InvalidDataException(); journal.ReadChain(key);
            if ((string)journal.header["projectIdentity"] != rootIdentity) throw new InvalidDataException();
          }
          bool alive; string generation = ScopeRecovery.ProcessCreation((int)journal.header["creatorPid"], out alive);
          if (alive && generation == (string)journal.header["creatorGeneration"]) throw new InvalidDataException();
          int journalVersion = (int)journal.header["version"];
          if (journalVersion < 2 || journalVersion > 5) throw new InvalidDataException();
          live(); result = journalVersion == 2 ? journal.RecoverKnownModify(rootIdentity, live) :
            journalVersion == 3 ? journal.RecoverKnownDelete(rootIdentity, live) :
            journalVersion == 4 ? journal.RecoverKnownRename(rootIdentity, live) : journal.RecoverKnownMixed(rootIdentity, live);
        });
        Console.WriteLine(Serializer().Serialize(result)); return 0;
      } catch {
        int version = journal != null && journal.header != null ? (int)journal.header["version"] : 0;
        if (version == 5) {
          bool attempted = journal.recoveryJournalAppendAttempted;
          Console.WriteLine(Serializer().Serialize(new { version = 1, status = "FAIL_BOUNDED_MIXED_TERMINAL_OBSERVATION",
            decision = "MANUAL_RECOVERY_REQUIRED", actionPerformed = attempted,
            journalMutations = attempted ? (object)"UNKNOWN" : 0, projectMutations = 0, processKills = 0,
            projectPublished = false, externalRequests = 0 })); return 70;
        }
        Console.WriteLine(Serializer().Serialize(new { version = 1, status = version == 2 ? "FAIL_BOUNDED_MODIFY_RECOVERY" :
            version == 3 ? "FAIL_BOUNDED_DELETE_RECOVERY" : "FAIL_BOUNDED_RENAME_RECOVERY", decision = "MANUAL_RECOVERY_REQUIRED",
          actionPerformed = journal != null && (journal.recoveryMutationUncertain || journal.recoveryProjectMutations != 0),
          projectMutations = journal == null ? (object)0 : journal.recoveryMutationUncertain ? (object)"UNKNOWN" : journal.recoveryProjectMutations,
          processKills = 0, projectPublished = false, externalRequests = 0 })); return 70;
      } finally { if (journal != null) journal.Dispose(); }
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
    static Dictionary<string, object> MixedFixtureHeader(string project, string transactionId) {
      Dictionary<string, object> snapshot = Snapshot(project, RecoveryFilesystem.DirectoryIdentity(project));
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"], identities = (Dictionary<string, object>)snapshot["identities"];
      bool alive; int pid = Process.GetCurrentProcess().Id;
      Func<string, string> digest = name => Hash(Encoding.UTF8.GetBytes((string)files[name]));
      Dictionary<string, object> draft = new Dictionary<string, object>(files);
      draft["a.txt"] = "a-new"; draft["b.txt"] = "b-new";
      draft.Remove("c.txt"); draft.Remove("d.txt"); draft["e.txt"] = files["d.txt"];
      return new Dictionary<string, object> {
        { "version", 5 }, { "transactionId", transactionId }, { "projectIdentity", snapshot["rootIdentity"] },
        { "draftId", Guid.NewGuid().ToString("N") }, { "draftVersion", 1 },
        { "verifiedDigest", ProjectDraftDigest(draft) },
        { "baseDigest", ProjectBaseDigest((string)snapshot["rootIdentity"], files, identities) },
        { "creatorPid", pid }, { "creatorGeneration", ScopeRecovery.ProcessCreation(pid, out alive) },
        { "operations", new object[] {
          new Dictionary<string, object> { { "path", "a.txt" }, { "kind", "REPLACE" }, { "baseIdentity", identities["a.txt"] },
            { "baseDigest", digest("a.txt") }, { "newDigest", Hash(Encoding.UTF8.GetBytes("a-new")) }, { "newBytes", 5 } },
          new Dictionary<string, object> { { "path", "b.txt" }, { "kind", "CREATE" }, { "baseIdentity", null },
            { "baseDigest", null }, { "newDigest", Hash(Encoding.UTF8.GetBytes("b-new")) }, { "newBytes", 5 } },
          new Dictionary<string, object> { { "path", "c.txt" }, { "kind", "DELETE" }, { "baseIdentity", identities["c.txt"] },
            { "baseDigest", digest("c.txt") }, { "newDigest", null }, { "newBytes", null } },
          new Dictionary<string, object> { { "sourcePath", "d.txt" }, { "path", "e.txt" }, { "kind", "RENAME" },
            { "baseIdentity", identities["d.txt"] }, { "baseDigest", digest("d.txt") }, { "newDigest", digest("d.txt") },
            { "newBytes", Encoding.UTF8.GetByteCount((string)files["d.txt"]) } }
        } }
      };
    }
    internal static int MixedPhysicalSuccessSelfTest() {
      ScopeRecovery scope = null; Process publisher = null; string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN";
      string gitDirectory = Path.Combine(Path.GetTempPath(), "phi-git-" + tx);
      bool passed = false, clean = false, gitClean = false, publisherGone = false, readerNoMutation = false;
      object evidence = null;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        File.WriteAllText(Path.Combine(scope.Root, "a.txt"), "a-old", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(scope.Root, "c.txt"), "c-old", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(scope.Root, "d.txt"), "d-old", new UTF8Encoding(false));
        stage = "GIT_BASELINE";
        if (Directory.Exists(gitDirectory) || File.Exists(gitDirectory)) throw new InvalidDataException();
        FixtureGit(scope.Root, "init -q --separate-git-dir \"" + gitDirectory + "\"");
        FixtureGit(scope.Root, "add -- a.txt c.txt d.txt");
        FixtureGit(scope.Root, "-c user.name=PhiFixture -c user.email=fixture@example.invalid commit -q -m baseline");
        if (FixtureGit(scope.Root, "status --porcelain -uall") != "") throw new InvalidDataException();
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        Dictionary<string, object> original = Snapshot(scope.Root, rootId);
        Dictionary<string, object> oldIdentities = (Dictionary<string, object>)original["identities"];
        Dictionary<string, object> header = MixedFixtureHeader(scope.Root, tx);
        header.Remove("version"); header.Remove("creatorPid"); header.Remove("creatorGeneration");
        string input = Serializer().Serialize(new { version = 1, root = scope.Root, header,
          modifyContent = "a-new", createContent = "b-new", guardianPid = Process.GetCurrentProcess().Id, timeoutMs = 10000 });
        stage = "PUBLISH";
        publisher = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-mixed", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        publisher.StandardInput.WriteLine(input); publisher.StandardInput.Close();
        string output = null, errors = null;
        Thread stdout = new Thread(delegate() { try { output = publisher.StandardOutput.ReadToEnd(); } catch { } });
        Thread stderr = new Thread(delegate() { try { errors = publisher.StandardError.ReadToEnd(); } catch { } });
        stdout.IsBackground = true; stderr.IsBackground = true; stdout.Start(); stderr.Start();
        if (!publisher.WaitForExit(15000)) { publisher.Kill(); publisher.WaitForExit(3000); throw new InvalidDataException(); }
        if (!stdout.Join(2000) || !stderr.Join(2000)) throw new InvalidDataException();
        publisherGone = publisher.HasExited;
        if (publisher.ExitCode != 0 || output == null || output.Length > 16384) throw new InvalidDataException();
        Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(output);
        if ((string)result["status"] != "PASS_NATIVE_MIXED" || (bool)result["projectPublished"] || (int)result["externalRequests"] != 0)
          throw new InvalidDataException();
        stage = "PHYSICAL";
        Dictionary<string, object> final = Snapshot(scope.Root, rootId);
        Dictionary<string, object> files = (Dictionary<string, object>)final["files"], identities = (Dictionary<string, object>)final["identities"];
        if (files.Count != 3 || (string)files["a.txt"] != "a-new" || (string)files["b.txt"] != "b-new" || (string)files["e.txt"] != "d-old" ||
            files.ContainsKey("c.txt") || files.ContainsKey("d.txt") || (string)identities["a.txt"] != (string)oldIdentities["a.txt"] ||
            (string)identities["e.txt"] != (string)oldIdentities["d.txt"] || (string)identities["b.txt"] == (string)oldIdentities["a.txt"] ||
            File.Exists(Path.Combine(scope.Root, DeleteLeaf(tx))) || File.Exists(Path.Combine(scope.Root, "phi-publish-" + tx + ".tmp")))
          throw new InvalidDataException();
        stage = "GIT_DIFF";
        string trackedDiff = FixtureGit(scope.Root, "diff --name-status --no-renames");
        string newFiles = FixtureGit(scope.Root, "ls-files --others --exclude-standard");
        if (!trackedDiff.Split('\n').SequenceEqual(new string[] { "M\ta.txt", "D\tc.txt", "D\td.txt" }) ||
            !newFiles.Split('\n').SequenceEqual(new string[] { "b.txt", "e.txt" })) throw new InvalidDataException();
        if (FixtureGit(scope.Root, "diff --check") != "") throw new InvalidDataException();
        stage = "FRESH_INSPECT";
        string before = Serializer().Serialize(final);
        Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(
          Serializer().Serialize(Inspect(tx, scope.Root, rootId)));
        Dictionary<string, object> metadata = observed["metadata"] as Dictionary<string, object>;
        IList physical = observed["operationEvidence"] as IList;
        if ((string)observed["status"] != "NEW_COMPLETE_OBSERVED" || (string)observed["filesystemState"] != "ALL_MUTATIONS_COMMITTED" ||
            (string)observed["recoveryDisposition"] != "TERMINAL_RETAINED" ||
            (int)observed["projectMutations"] != 0 || (int)observed["journalMutations"] != 0 || (bool)observed["projectPublished"] ||
            (string)metadata["phase"] != "CLEANED" || (string)metadata["journalState"] != "FINALIZED" ||
            (int)metadata["journalPendingOperations"] != 0 || physical == null || physical.Count != 4 ||
            physical.Cast<object>().Any(item => (string)((Dictionary<string, object>)item)["physicalState"] != "NEW_COMPLETE_OBSERVED"))
          throw new InvalidDataException();
        readerNoMutation = before == Serializer().Serialize(Snapshot(scope.Root, rootId));
        if (!readerNoMutation) throw new InvalidDataException();
        evidence = new { phase = metadata["phase"], journalState = metadata["journalState"], recoveryDisposition = observed["recoveryDisposition"],
          operationStates = physical.Cast<object>().Select(item => ((Dictionary<string, object>)item)["physicalState"]).ToArray(),
          createIdentityPreserved = (string)identities["b.txt"] == (string)((Dictionary<string, object>)physical[1])["observedDestinationIdentity"],
          renameIdentityPreserved = (string)identities["e.txt"] == (string)oldIdentities["d.txt"],
          deleteDestinationAbsent = !files.ContainsKey("c.txt"), quarantineAbsent = true, draftDigestMatched = true,
          gitDiffOnlyIntendedFiveFiles = true };
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_MIXED_PHYSICAL_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8")); }
      finally {
        if (publisher != null) { try { if (!publisher.HasExited) { publisher.Kill(); publisher.WaitForExit(3000); } } finally { publisher.Dispose(); } }
        try { CleanupFixtureGit(gitDirectory, tx); gitClean = true; } catch { gitClean = false; }
        try { using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { passed, scope = "V5_NATIVE_MIXED_NO_CRASH_PHYSICAL_ONLY", publisherGone,
        readerNoMutation, fixtureCleanup = clean && gitClean, gitMetadataClean = gitClean, evidence,
        projectPublished = false, externalRequests = 0 }));
      return passed && clean && gitClean && publisherGone ? 0 : 70;
    }
    static string MixedCrashCheckpoint(string name) {
      if (name == "before-first") return "before-first";
      if (name == "after-modify") return "modify-cleanup";
      if (name == "after-create") return "create-finalized";
      if (name == "after-delete") return "delete-finalized-retained";
      if (name == "after-rename-moved") return "rename-moved";
      if (name == "after-all-mutations") return "rename-finalized";
      if (name == "after-cleanup-intent") return "cleanup-intent";
      if (name == "after-cleanup-unlinked") return "cleanup-unlinked";
      throw new InvalidDataException();
    }
    internal static int MixedPhysicalCrashChild(string name) {
      try {
        string stop = MixedCrashCheckpoint(name);
        Dictionary<string, object> request = FixtureRequest();
        string project = Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]), tx = (string)request["transactionId"];
        if (RecoveryFilesystem.DirectoryIdentity(project) != (string)request["rootIdentity"]) throw new InvalidDataException();
        using (PublicationJournal journal = Begin(project, MixedFixtureHeader(project, tx))) {
          Action<string> checkpoint = delegate(string observed) {
            if (observed != stop) return;
            Console.WriteLine(Serializer().Serialize(new { ready = true, phase = journal.last["phase"], transactionId = tx }));
            Console.Out.Flush(); Thread.Sleep(12000);
          };
          if (stop == "before-first") checkpoint(stop);
          journal.PublishMixed(Encoding.UTF8.GetBytes("a-new"), Encoding.UTF8.GetBytes("b-new"), checkpoint);
          throw new InvalidDataException(); // The parent must kill at the selected boundary.
        }
      } catch { Console.Error.WriteLine("PHI_MIXED_CRASH_CHILD_FAILED"); return 70; }
    }
    internal static int MixedPhysicalCrashSelfTest(string name) {
      string stop, childCaseName = new string[] { "race-after-observation", "quarantine-returned", "corrupt-journal",
        "concurrent-terminal", "append-interrupted" }.Contains(name) ?
        "after-cleanup-unlinked" : name;
      try { stop = MixedCrashCheckpoint(childCaseName); } catch { return 70; }
      ScopeRecovery scope = null; Process publisher = null; string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN";
      Stopwatch diagnosticClock = Stopwatch.StartNew();
      string failureStage = null, failureHresult = null;
      string lastCompletedStage = "BEGIN", readinessResult = "NOT_STARTED", readinessClass = "UNKNOWN";
      long fixtureSetupMs = -1, publisherSpawnMs = -1, readinessElapsedMs = -1, cleanupElapsedMs = -1;
      int? publisherPid = null, publisherExitAtReadiness = null, residualTrackedPublisher = null;
      bool? publisherAliveAtReadiness = null, publisherInAnyJob = null;
      bool publisherKillAttempted = false, stdoutPipeClosed = false, stderrPipeDrained = false;
      int readinessProbeCount = 0;
      Thread readyPipe = null;
      string gitDirectory = Path.Combine(Path.GetTempPath(), "phi-git-" + tx);
      bool passed = false, clean = false, gitClean = false, killed = false, publisherGone = false, readerGone = false;
      bool firstStartupGone = false, secondStartupGone = false, startupIdempotent = false;
      bool externalChangedAfterObservation = false, laterClassificationSawChange = false;
      bool liveOwnerDenied = false, duplicateTerminalDenied = false;
      bool corruptJournalRejected = false, concurrentSingleTerminal = false, appendInterruptionFailClosed = false;
      int firstStartupExit = -1, secondStartupExit = -1;
      object evidence = null;
      try {
        stage = "FIXTURE_SETUP";
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        File.WriteAllText(Path.Combine(scope.Root, "a.txt"), "a-old", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(scope.Root, "c.txt"), "c-old", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(scope.Root, "d.txt"), "d-old", new UTF8Encoding(false));
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        if (Directory.Exists(gitDirectory) || File.Exists(gitDirectory)) throw new InvalidDataException();
        FixtureGit(scope.Root, "init -q --separate-git-dir \"" + gitDirectory + "\"");
        FixtureGit(scope.Root, "add -- a.txt c.txt d.txt");
        FixtureGit(scope.Root, "-c user.name=Phi -c user.email=phi@example.invalid commit -qm baseline");
        if (FixtureGit(scope.Root, "status --porcelain") != "") throw new InvalidDataException();
        string input = Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx });
        fixtureSetupMs = diagnosticClock.ElapsedMilliseconds; lastCompletedStage = "FIXTURE_SETUP";
        stage = "PUBLISHER_START";
        publisher = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-mixed-physical-crash-child " + childCaseName, UseShellExecute = false,
          RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        if (publisher == null) throw new InvalidDataException();
        publisherPid = publisher.Id; publisherSpawnMs = diagnosticClock.ElapsedMilliseconds;
        try { bool inJob; if (IsProcessInJob(publisher.Handle, IntPtr.Zero, out inJob)) publisherInAnyJob = inJob; } catch { }
        lastCompletedStage = "PUBLISHER_START";
        stage = "PUBLISHER_INPUT";
        publisher.StandardInput.WriteLine(input); publisher.StandardInput.Close();
        lastCompletedStage = "PUBLISHER_INPUT";
        string ready = null;
        readyPipe = new Thread(delegate() {
          try { ready = publisher.StandardOutput.ReadLine(); readinessResult = ready == null ? "EOF" : "LINE"; }
          catch { readinessResult = "READ_EXCEPTION"; }
        });
        readyPipe.IsBackground = true; readinessProbeCount = 1; readinessResult = "PENDING";
        Stopwatch readinessClock = Stopwatch.StartNew(); readyPipe.Start();
        stage = "PUBLISHER_READY_WAIT";
        bool readyCompleted = readyPipe.Join(7000);
        readinessElapsedMs = readinessClock.ElapsedMilliseconds;
        if (!readyCompleted) { stage = "PUBLISHER_READY_TIMEOUT"; throw new InvalidDataException(); }
        if (ready == null) { stage = "PUBLISHER_READY_MISSING"; throw new InvalidDataException(); }
        if (ready.Length > 1024) { stage = "PUBLISHER_READY_OVERSIZE"; throw new InvalidDataException(); }
        stage = "PUBLISHER_READY_PARSE";
        Dictionary<string, object> announced = Serializer().Deserialize<Dictionary<string, object>>(ready);
        if (!(bool)announced["ready"] || (string)announced["transactionId"] != tx) throw new InvalidDataException();
        readinessClass = "SUCCESS";
        try { publisherAliveAtReadiness = !publisher.HasExited;
          if (!publisherAliveAtReadiness.Value) publisherExitAtReadiness = publisher.ExitCode; } catch { }
        lastCompletedStage = "PUBLISHER_READY_PARSE";
        if (name == "after-cleanup-unlinked") {
          stage = "LIVE_OWNER_INSPECT";
          Dictionary<string, object> active = Serializer().Deserialize<Dictionary<string, object>>(
            Serializer().Serialize(Inspect(tx, scope.Root, rootId)));
          liveOwnerDenied = (string)active["status"] == "ACTIVE" && (int)active["journalMutations"] == 0 &&
            (int)active["projectMutations"] == 0 && !(bool)active["projectPublished"];
          if (!liveOwnerDenied) throw new InvalidDataException();
        }
        stage = "KILL"; publisherKillAttempted = true; publisher.Kill(); killed = true;
        if (!publisher.WaitForExit(3000) || !publisher.HasExited || publisher.ExitCode == 0) throw new InvalidDataException();
        publisherGone = true;
        stage = "FRESH_READER_START";
        using (Process reader = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-mixed-journal-fixture-read", UseShellExecute = false,
          RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
          reader.StandardInput.WriteLine(input); reader.StandardInput.Close();
          string output = null, errors = null;
          Thread stdout = new Thread(delegate() { try { output = reader.StandardOutput.ReadToEnd(); } catch { } });
          Thread stderr = new Thread(delegate() { try { errors = reader.StandardError.ReadToEnd(); } catch { } });
          stdout.IsBackground = true; stderr.IsBackground = true; stdout.Start(); stderr.Start();
          stage = "FRESH_READER_EXIT";
          if (!reader.WaitForExit(7000)) { reader.Kill(); reader.WaitForExit(3000); throw new InvalidDataException(); }
          if (!stdout.Join(2000) || !stderr.Join(2000) || reader.ExitCode != 0 || output == null || output.Length > 8192)
            throw new InvalidDataException();
          readerGone = reader.HasExited;
          stage = "FRESH_READER_CONTRACT";
          Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(output);
          Dictionary<string, object> metadata = observed["metadata"] as Dictionary<string, object>;
          IList operations = observed["operationEvidence"] as IList;
          IList states = metadata["operationStates"] as IList;
          int committed = name == "before-first" ? 0 : name == "after-modify" ? 1 : name == "after-create" ? 2 :
            name == "after-delete" ? 3 : 4;
          string[] expectedPhysical = Enumerable.Range(0, 4).Select(index => index < committed ? "NEW_COMPLETE_OBSERVED" : "OLD_COMPLETE_OBSERVED").ToArray();
          string expectedFilesystem = committed == 0 ? "NONE_COMMITTED" : committed == 4 ? "ALL_MUTATIONS_COMMITTED" : "PARTIALLY_COMMITTED";
          if ((string)observed["status"] != (childCaseName == "after-cleanup-unlinked" ? "NEW_COMPLETE_OBSERVED" : "UNKNOWN_FAIL_SAFE") ||
              (string)observed["filesystemState"] != expectedFilesystem ||
              (int)observed["projectMutations"] != 0 || (int)observed["journalMutations"] != 0 || (bool)observed["projectPublished"] ||
              operations == null || operations.Count != 4 || states == null || states.Count != 4 ||
              !operations.Cast<object>().Select(item => (string)((Dictionary<string, object>)item)["physicalState"]).SequenceEqual(expectedPhysical))
            throw new InvalidDataException();
          evidence = new { durablePhase = metadata["phase"], journalState = metadata["journalState"], filesystemState = observed["filesystemState"],
            recoveryDisposition = observed["recoveryDisposition"],
            operationPhysicalStates = expectedPhysical, journalMutationsByReader = observed["journalMutations"], projectMutationsByReader = observed["projectMutations"] };
        }
        stage = "PHYSICAL_STATE";
        bool quarantine = File.Exists(Path.Combine(scope.Root, DeleteLeaf(tx)));
        bool temp = File.Exists(Path.Combine(scope.Root, "phi-publish-" + tx + ".tmp"));
        if (temp || quarantine != (MixedDeleteCommitted(name) && childCaseName != "after-cleanup-unlinked") ||
            File.ReadAllText(Path.Combine(scope.Root, "a.txt")) != (name == "before-first" ? "a-old" : "a-new") ||
            File.Exists(Path.Combine(scope.Root, "b.txt")) != (name != "before-first" && name != "after-modify") ||
            File.Exists(Path.Combine(scope.Root, "c.txt")) == MixedDeleteCommitted(name) ||
            File.Exists(Path.Combine(scope.Root, "e.txt")) != (name == "after-rename-moved" || name == "after-all-mutations" ||
              name == "after-cleanup-intent" || childCaseName == "after-cleanup-unlinked")) throw new InvalidDataException();
        if (name == "race-after-observation") {
          stage = "EXTERNAL_RACE_AFTER_NATIVE_OBSERVATION";
          using (PublicationJournal recovery = new PublicationJournal(tx, scope.Root))
          using (RegistryKey registry = OpenBase(false)) using (RegistryKey key = registry.OpenSubKey(tx, false)) {
            if (key == null) throw new InvalidDataException(); recovery.ReadChain(key);
            bool alive; string generation = ScopeRecovery.ProcessCreation((int)recovery.header["creatorPid"], out alive);
            if (alive && generation == (string)recovery.header["creatorGeneration"]) throw new InvalidDataException();
            recovery.RecoverKnownMixed(rootId, delegate() { }, delegate() {
              using (Process actor = Process.Start(new ProcessStartInfo { FileName = "node",
                Arguments = "-e \"require('fs').writeFileSync('a.txt','external-edit')\"", WorkingDirectory = scope.Root,
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
                if (!actor.WaitForExit(5000) || actor.ExitCode != 0) throw new InvalidDataException();
              }
              externalChangedAfterObservation = File.ReadAllText(Path.Combine(scope.Root, "a.txt")) == "external-edit";
              if (!externalChangedAfterObservation) throw new InvalidDataException();
            });
          }
          Dictionary<string, object> changed = Serializer().Deserialize<Dictionary<string, object>>(
            Serializer().Serialize(Inspect(tx, scope.Root, rootId)));
          laterClassificationSawChange = (string)changed["status"] == "CONFLICT" &&
            (int)changed["projectMutations"] == 0 && (bool)changed["projectPublished"] == false;
          if (!laterClassificationSawChange) throw new InvalidDataException();
        }
        if (name == "quarantine-returned") {
          stage = "EXTERNAL_QUARANTINE_RETURN";
          File.WriteAllText(Path.Combine(scope.Root, DeleteLeaf(tx)), "external-quarantine", new UTF8Encoding(false));
        }
        // The ordinary user-facing Phi path must discover this dead V5 journal
        // and fail closed twice. The read-only inspector above is not a
        // substitute for normal startup, and a startup attempt must not alter
        // even a retained transaction quarantine or the private journal.
        stage = "PRE_STARTUP_SNAPSHOT";
        string quarantineLeaf = DeleteLeaf(tx), quarantineIdentity = null, quarantineDigest = null;
        using (RecoveryFilesystem parent = new RecoveryFilesystem(scope.Root)) {
          DeleteObject held = ReadDeleteLeaf(parent, quarantineLeaf);
          if (held != null) { quarantineIdentity = held.Identity; quarantineDigest = held.Digest; }
        }
        string projectBefore = Serializer().Serialize(Snapshot(scope.Root, rootId, quarantineLeaf));
        string gitDiffBefore = FixtureGit(scope.Root, "diff --name-only --no-renames");
        int sequenceBefore;
        string phaseBefore;
        using (PublicationJournal journal = new PublicationJournal(tx, scope.Root))
        using (RegistryKey registry = OpenBase(false)) using (RegistryKey key = registry.OpenSubKey(tx, false)) {
          if (key == null) throw new InvalidDataException(); journal.ReadChain(key);
          sequenceBefore = (int)journal.last["sequence"]; phaseBefore = (string)journal.last["phase"];
        }
        byte[] corruptEvent = null;
        if (name == "corrupt-journal") {
          stage = "CORRUPT_LAST_EVENT";
          using (RegistryKey registry = OpenBase(true)) using (RegistryKey key = registry.OpenSubKey(tx, true)) {
            if (key == null) throw new InvalidDataException();
            string eventName = "E" + sequenceBefore.ToString("D8");
            corruptEvent = ReadValue(key, eventName); corruptEvent[8] ^= 1;
            key.SetValue(eventName, corruptEvent, RegistryValueKind.Binary);
            if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0 || !ReadValue(key, eventName).SequenceEqual(corruptEvent)) throw new InvalidDataException();
          }
        }
        if (name == "concurrent-terminal") {
          stage = "CONCURRENT_TERMINAL_APPENDS";
          Process[] contenders = new Process[2]; int succeeded = 0, failed = 0;
          try {
            for (int i = 0; i < contenders.Length; i++) contenders[i] = Process.Start(new ProcessStartInfo {
              FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--publication-recover-known",
              UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true,
              RedirectStandardError = true, CreateNoWindow = true });
            string request = Serializer().Serialize(new { version = 1, root = scope.Root, transactionId = tx,
              guardianPid = Process.GetCurrentProcess().Id, timeoutMs = 10000 });
            foreach (Process contender in contenders) { contender.StandardInput.WriteLine(request); contender.StandardInput.Close(); }
            foreach (Process contender in contenders) {
              if (!contender.WaitForExit(15000)) throw new InvalidDataException();
              string output = contender.StandardOutput.ReadToEnd();
              if (output.Length > 8192) throw new InvalidDataException();
              Dictionary<string, object> result = Serializer().Deserialize<Dictionary<string, object>>(output);
              if (contender.ExitCode == 0 && (string)result["status"] == "PASS_BOUNDED_MIXED_TERMINAL_OBSERVATION" &&
                  (int)result["projectMutations"] == 0 && !(bool)result["projectPublished"]) succeeded++;
              else if (contender.ExitCode == 70 && ((string)result["status"]).StartsWith("FAIL_BOUNDED_", StringComparison.Ordinal) &&
                  !(bool)result["projectPublished"]) failed++;
              else throw new InvalidDataException();
            }
          } finally { foreach (Process contender in contenders) if (contender != null) {
            if (!contender.HasExited) { contender.Kill(); contender.WaitForExit(3000); } contender.Dispose(); } }
          concurrentSingleTerminal = succeeded == 1 && failed == 1;
          if (!concurrentSingleTerminal) throw new InvalidDataException();
        }
        if (name == "append-interrupted") {
          stage = "INTERRUPT_TERMINAL_APPEND_BEFORE_FLUSH";
          using (PublicationJournal interrupted = new PublicationJournal(tx, scope.Root))
          using (RegistryKey registry = OpenBase(false)) using (RegistryKey key = registry.OpenSubKey(tx, false)) {
            if (key == null) throw new InvalidDataException(); interrupted.ReadChain(key);
            interrupted.fixtureAfterRecoveryTerminalSetValue = delegate() { throw new InvalidDataException(); };
            try { interrupted.RecoverKnownMixed(rootId, delegate() { }); }
            catch (InvalidDataException) { appendInterruptionFailClosed = interrupted.recoveryJournalAppendAttempted && interrupted.poisoned; }
          }
          if (!appendInterruptionFailClosed || Serializer().Serialize(Snapshot(scope.Root, rootId, quarantineLeaf)) != projectBefore)
            throw new InvalidDataException();
        }
        stage = "FIRST_NORMAL_PHI_STARTUP";
        string firstError, secondError;
        Dictionary<string, object> first = RunNormalPhiStartup(scope.Root, out firstStartupGone, out firstStartupExit, out firstError);
        stage = "SECOND_NORMAL_PHI_STARTUP";
        Dictionary<string, object> second = RunNormalPhiStartup(scope.Root, out secondStartupGone, out secondStartupExit, out secondError);
        stage = "STARTUP_RECEIPT_CONTRACT";
        bool eligible = name == "after-cleanup-unlinked",
          alreadyTerminal = name == "concurrent-terminal" || name == "append-interrupted";
        foreach (Dictionary<string, object> startup in new Dictionary<string, object>[] { first, second }) {
          if (name == "corrupt-journal") {
            if ((string)startup["status"] != "UNKNOWN_FAIL_SAFE" || startup["journalMutations"] != null ||
                startup["projectMutations"] != null || (bool)startup["projectPublished"] ||
                (int)startup["externalRequests"] != 0) throw new InvalidDataException();
            continue;
          }
          bool initial = Object.ReferenceEquals(startup, first);
          if ((string)startup["status"] != (eligible ? initial ? "PASS_RECOVERED" : "PASS_NO_PENDING" :
                alreadyTerminal ? "PASS_NO_PENDING" : "BLOCKED") ||
              (string)startup["reason"] != (eligible ? initial ? "RECORD_TERMINAL_OBSERVATION" : "NO_NONTERMINAL_TRANSACTION" :
                alreadyTerminal ? "NO_NONTERMINAL_TRANSACTION" : name == "race-after-observation" || name == "quarantine-returned" ?
                  "BLOCKED_CONFLICT" : "BLOCKED_MANUAL_RECOVERY_REQUIRED") ||
              (string)startup["rootIdentity"] != rootId ||
              !alreadyTerminal && (initial || !eligible) && ((string)startup["transactionId"] != tx || (int)startup["journalVersion"] != 5) ||
              (int)startup["projectMutations"] != 0 ||
              (int)startup["journalMutations"] != (eligible && initial ? 1 : 0) || (bool)startup["projectPublished"] ||
              (int)startup["externalRequests"] != 0) throw new InvalidDataException();
        }
        stage = "STARTUP_SIDE_EFFECTS";
        if (!firstStartupGone || !secondStartupGone || firstStartupExit != 1 || secondStartupExit != 1 ||
            firstError != (eligible || alreadyTerminal ? "PHI_SANDBOX_UNAVAILABLE: native Windows isolation is not yet verified; engine execution is blocked" :
              name == "corrupt-journal" ? "PHI_STARTUP_RECOVERY_UNCONFIRMED" : "PHI_STARTUP_RECOVERY_BLOCKED") ||
            secondError != (eligible || alreadyTerminal ? "PHI_SANDBOX_UNAVAILABLE: native Windows isolation is not yet verified; engine execution is blocked" :
              name == "corrupt-journal" ? "PHI_STARTUP_RECOVERY_UNCONFIRMED" : "PHI_STARTUP_RECOVERY_BLOCKED") ||
            Serializer().Serialize(Snapshot(scope.Root, rootId, quarantineLeaf)) != projectBefore ||
            FixtureGit(scope.Root, "diff --name-only --no-renames") != gitDiffBefore ||
            FixtureGit(scope.Root, "diff --check") != "") throw new InvalidDataException();
        if (eligible) {
          stage = "DUPLICATE_TERMINAL_DENIAL";
          using (PublicationJournal duplicate = new PublicationJournal(tx, scope.Root))
          using (RegistryKey registry = OpenBase(false)) using (RegistryKey key = registry.OpenSubKey(tx, false)) {
            if (key == null) throw new InvalidDataException(); duplicate.ReadChain(key);
            try { duplicate.RecoverKnownMixed(rootId, delegate() { }); }
            catch (InvalidDataException) { duplicateTerminalDenied = true; }
          }
          if (!duplicateTerminalDenied) throw new InvalidDataException();
        }
        stage = "QUARANTINE_IDENTITY";
        using (RecoveryFilesystem parent = new RecoveryFilesystem(scope.Root)) {
          DeleteObject held = ReadDeleteLeaf(parent, quarantineLeaf);
          if ((held == null ? null : held.Identity) != quarantineIdentity ||
              (held == null ? null : held.Digest) != quarantineDigest) throw new InvalidDataException();
        }
        stage = "TERMINAL_JOURNAL_STATE";
        if (name == "corrupt-journal") {
          using (RegistryKey registry = OpenBase(false)) using (RegistryKey key = registry.OpenSubKey(tx, false)) {
            if (key == null) throw new InvalidDataException();
            corruptJournalRejected = ReadValue(key, "E" + sequenceBefore.ToString("D8")).SequenceEqual(corruptEvent);
            startupIdempotent = corruptJournalRejected && key.GetValueNames().Length == sequenceBefore + 1;
          }
        } else using (PublicationJournal journal = new PublicationJournal(tx, scope.Root))
          using (RegistryKey registry = OpenBase(false)) using (RegistryKey key = registry.OpenSubKey(tx, false)) {
            if (key == null) throw new InvalidDataException(); journal.ReadChain(key);
            startupIdempotent = (int)journal.last["sequence"] == sequenceBefore + (eligible || alreadyTerminal ? 1 : 0) &&
              (string)journal.last["phase"] == (eligible || alreadyTerminal ? "CLEANED" : phaseBefore) &&
              (!(eligible || alreadyTerminal) || journal.last.ContainsKey("terminalObservation") &&
                (string)journal.last["terminalObservation"] == RecoveryTerminalObservation);
          }
        if (!startupIdempotent) throw new InvalidDataException();
        passed = true; stage = "COMPLETE"; lastCompletedStage = "COMPLETE";
      } catch (Exception error) {
        failureStage = stage; failureHresult = unchecked((uint)Marshal.GetHRForException(error)).ToString("x8");
        if (publisher != null) try {
          publisherAliveAtReadiness = !publisher.HasExited;
          if (!publisherAliveAtReadiness.Value) publisherExitAtReadiness = publisher.ExitCode;
        } catch { }
        if (stage == "PUBLISHER_START") readinessClass = "SPAWN_FAILURE";
        else if (stage == "PUBLISHER_READY_TIMEOUT" || stage == "PUBLISHER_READY_MISSING") {
          readinessClass = readinessResult == "READ_EXCEPTION" ? "READINESS_OBSERVATION_FAILURE" :
            publisherAliveAtReadiness == false ? "EARLY_EXIT" :
            publisherAliveAtReadiness == true ? "ALIVE_NOT_READY" : "UNKNOWN";
        } else if (stage == "PUBLISHER_READY_OVERSIZE" || stage == "PUBLISHER_READY_PARSE")
          readinessClass = "READINESS_OBSERVATION_FAILURE";
        Console.Error.WriteLine("PHI_MIXED_CRASH_SELFTEST_FAILED:" + failureStage + ":" + failureHresult);
      }
      finally {
        Stopwatch cleanupClock = Stopwatch.StartNew();
        if (publisher != null) { try {
          if (!publisher.HasExited) { publisherKillAttempted = true; publisher.Kill(); publisher.WaitForExit(3000); }
          residualTrackedPublisher = publisher.HasExited ? 0 : 1;
          if (publisher.HasExited) { try { publisher.StandardError.ReadToEnd(); stderrPipeDrained = true; } catch { } }
        } finally { publisher.Dispose(); } }
        stdoutPipeClosed = readyPipe != null && readyPipe.Join(1000);
        try { CleanupFixtureGit(gitDirectory, tx); gitClean = true; } catch { gitClean = false; }
        try { using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
        cleanupElapsedMs = cleanupClock.ElapsedMilliseconds;
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, checkpoint = stop, passed, actualPublisherKilled = killed,
        publisherGone, freshReaderGone = readerGone, firstStartupGone, secondStartupGone, firstStartupExit, secondStartupExit,
        normalPhiStartupsBlocked = passed && name != "after-cleanup-unlinked" && name != "concurrent-terminal" &&
          name != "append-interrupted", startupIdempotent, fixtureCleanup = clean && gitClean,
        gitMetadataClean = gitClean, externalChangedAfterObservation, laterClassificationSawChange,
        liveOwnerDenied, duplicateTerminalDenied, corruptJournalRejected, concurrentSingleTerminal, appendInterruptionFailClosed, evidence,
        diagnostic = name == "after-cleanup-unlinked" || name == "corrupt-journal" ? new { lastStage = stage, lastCompletedStage,
          failureStage, failureHresult, readinessClass = !clean || !gitClean || residualTrackedPublisher == 1 ? "CLEANUP_FAILURE" :
            passed ? "SUCCESS" : readinessClass,
          elapsedMs = diagnosticClock.ElapsedMilliseconds, fixtureCleanup = clean && gitClean,
          publisherGone, readerGone, firstStartupGone, secondStartupGone,
          fixtureSetupMs, publisherSpawnMs, readinessElapsedMs, cleanupElapsedMs, publisherPid, publisherInAnyJob,
          publisherAliveAtReadiness, publisherExitAtReadiness, readinessProbeCount, readinessResult,
          publisherKillAttempted, stdoutPipeClosed, stderrPipeDrained, residualTrackedPublisher } : null,
        scope = "V5_PHYSICAL_DEATH_FRESH_READER_TERMINAL_OBSERVATION_ONLY",
        projectPublished = false, externalRequests = 0 }));
      return passed && clean && gitClean && publisherGone && readerGone && firstStartupGone && secondStartupGone && startupIdempotent ? 0 : 70;
    }
    static bool MixedDeleteCommitted(string name) {
      return name == "after-delete" || name == "after-rename-moved" || name == "after-all-mutations" ||
        name == "after-cleanup-intent" || name == "after-cleanup-unlinked" || name == "race-after-observation" ||
        name == "quarantine-returned" || name == "corrupt-journal" || name == "concurrent-terminal" || name == "append-interrupted";
    }
    internal static int MixedJournalFixtureChild(string name) {
      if (name != "partial-after-modify-journal-only" && name != "partial-after-real-modify" &&
          name != "partial-after-real-modify-user-e" && name != "partial-after-real-modify-create-staged" &&
          name != "partial-after-real-modify-create-committed" && name != "partial-after-real-modify-create-committed-user-b") return 70;
      try {
        Dictionary<string, object> request = FixtureRequest();
        string root = Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]), tx = (string)request["transactionId"];
        using (PublicationJournal journal = Begin(root, MixedFixtureHeader(root, tx)))
        using (RegistryKey registry = OpenBase(true)) using (RegistryKey key = registry.OpenSubKey(tx, true)) {
          if (key == null) throw new InvalidDataException();
          journal.ReadChain(key);
          string original = (string)((Dictionary<string, object>)Operations(journal.header)[0])["baseIdentity"];
          bool earlyNextDenied = false, earlyCleanDenied = false;
          try { journal.Append(key, "PREPARED", 1, null, null, true); }
          catch (InvalidDataException) { earlyNextDenied = true; }
          if (!earlyNextDenied) throw new InvalidDataException();
          if (name != "partial-after-modify-journal-only") {
            journal.PublishMixedModify(Encoding.UTF8.GetBytes("a-new"), delegate(string phase) { });
          } else {
            foreach (string phase in new string[] { "MUTATION_STARTED", "COMMITTED", "POST_COMMIT_VERIFIED", "FINALIZED" })
              journal.Append(key, phase, 0, original, phase == "MUTATION_STARTED" ? null : original, true);
          }
          journal.ObserveMixed(1, "PREPARED", null, null);
          if (name == "partial-after-real-modify-create-staged") {
            try {
              AnchoredFile.CreateNoReplace(root, (string)journal.header["projectIdentity"], "b.txt", Encoding.UTF8.GetBytes("b-new"),
                "phi-publish-" + tx + ".tmp", delegate(string phase, string identity) {
                  if (phase == "temp") journal.Append(key, "MUTATION_STARTED", 1, identity, null, true);
                  if (phase == "flush") throw new IOException("PHI_MIXED_STAGED_CREATE_FIXTURE");
                });
              throw new InvalidDataException();
            } catch (IOException error) { if (error.Message != "PHI_MIXED_STAGED_CREATE_FIXTURE") throw; }
          } else if (name == "partial-after-real-modify-create-committed" || name == "partial-after-real-modify-create-committed-user-b") {
            journal.PublishMixedCreate(Encoding.UTF8.GetBytes("b-new"), delegate(string phase) { });
            journal.ObserveMixed(2, "PREPARED", null, null);
          }
          int activeIndex = (name == "partial-after-real-modify-create-committed" || name == "partial-after-real-modify-create-committed-user-b") ? 2 : 1;
          try { journal.Append(key, "CLEANED", activeIndex, null, null, true); }
          catch (InvalidDataException) { earlyCleanDenied = true; }
          if (!earlyCleanDenied) throw new InvalidDataException();
          journal.ReadChain(key);
          Console.WriteLine(Serializer().Serialize(new { ready = true, phase = journal.last["phase"], transactionId = tx,
            sequence = journal.last["sequence"], earlyNextDenied, earlyCleanDenied })); Console.Out.Flush();
          Thread.Sleep(12000); return 70;
        }
      } catch { Console.Error.WriteLine("PHI_MIXED_JOURNAL_FIXTURE_CHILD_FAILED"); return 70; }
    }
    internal static int MixedJournalFixtureRead() {
      try {
        Dictionary<string, object> request = FixtureRequest();
        Console.Error.WriteLine("PHI_MIXED_STAGE:INSPECT_START");
        object observed = Inspect((string)request["transactionId"], Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]),
          (string)request["rootIdentity"], false, delegate(string token) { Console.Error.WriteLine("PHI_MIXED_STAGE:" + token); });
        Console.Error.WriteLine("PHI_MIXED_STAGE:INSPECT_DONE");
        Console.WriteLine(Serializer().Serialize(observed)); return 0;
      } catch (Exception error) {
        Console.Error.WriteLine("PHI_MIXED_JOURNAL_FIXTURE_READ_FAILED:" + error.GetType().Name + ":" +
          unchecked((uint)Marshal.GetHRForException(error)).ToString("x8") + ":" +
          (error.TargetSite == null ? "UNKNOWN" : error.TargetSite.Name)); return 70;
      }
    }
    internal static int MixedJournalSelfTest(string name) {
      if (name != "partial-after-modify-journal-only" && name != "partial-after-real-modify" &&
          name != "partial-after-real-modify-user-e" && name != "partial-after-real-modify-create-staged" &&
          name != "partial-after-real-modify-create-committed" && name != "partial-after-real-modify-create-committed-user-b") return 70;
      ScopeRecovery scope = null; Process child = null; string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN";
      bool stagedCreate = name == "partial-after-real-modify-create-staged";
      bool committedCreate = name == "partial-after-real-modify-create-committed" || name == "partial-after-real-modify-create-committed-user-b";
      bool userChangedB = name == "partial-after-real-modify-create-committed-user-b";
      bool passed = false, clean = false, killed = false, childGone = false, readerGone = false, snapshotUnchanged = false;
      int readerOutputBytes = 0;
      object evidence = null;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        File.WriteAllText(Path.Combine(scope.Root, "a.txt"), "a-old", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(scope.Root, "c.txt"), "c-old", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(scope.Root, "d.txt"), "d-old", new UTF8Encoding(false));
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        string before = Serializer().Serialize(Snapshot(scope.Root, rootId));
        string input = Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx });
        stage = "PUBLISHER";
        child = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-mixed-journal-fixture-child " + name, UseShellExecute = false,
          RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        child.StandardInput.WriteLine(input); child.StandardInput.Close();
        string ready = null; Thread line = new Thread(delegate() { try { ready = child.StandardOutput.ReadLine(); } catch { } }); line.IsBackground = true; line.Start();
        if (!line.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
        Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
        if (!(bool)announcement["ready"] || (string)announcement["transactionId"] != tx ||
            (string)announcement["phase"] != (stagedCreate ? "MUTATION_STARTED" : "PREPARED") ||
            (int)announcement["sequence"] != (stagedCreate ? 6 : committedCreate ? 10 : 5) ||
            !(bool)announcement["earlyNextDenied"] || !(bool)announcement["earlyCleanDenied"]) throw new InvalidDataException();
        stage = "KILL"; child.Kill(); killed = true;
        if (!child.WaitForExit(3000) || !child.HasExited || child.ExitCode == 0) throw new InvalidDataException(); childGone = true;
        if (name == "partial-after-real-modify-user-e") File.WriteAllText(Path.Combine(scope.Root, "e.txt"), "private-user-e-content", new UTF8Encoding(false));
        if (userChangedB) File.WriteAllText(Path.Combine(scope.Root, "b.txt"), "private-user-b-content", new UTF8Encoding(false));
        stage = "FRESH_READER";
        using (Process reader = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-mixed-journal-fixture-read", UseShellExecute = false,
          RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
          reader.StandardInput.WriteLine(input); reader.StandardInput.Close();
          // The V5 receipt can exceed the Windows pipe buffer. Drain both
          // redirected streams while waiting, or the child blocks in WriteLine
          // and a perfectly healthy reader appears to time out at 7000 ms.
          string output = null, readerErrors = null;
          Thread outputPipe = new Thread(delegate() { try { output = reader.StandardOutput.ReadToEnd(); } catch { } });
          Thread errorPipe = new Thread(delegate() { try { readerErrors = reader.StandardError.ReadToEnd(); } catch { } });
          outputPipe.IsBackground = true; errorPipe.IsBackground = true; outputPipe.Start(); errorPipe.Start();
          stage = "READER_WAIT";
          if (!reader.WaitForExit(7000)) {
            reader.Kill(); reader.WaitForExit(3000);
            outputPipe.Join(2000); errorPipe.Join(2000);
            foreach (string marker in (readerErrors ?? "").Split('\n').Where(entry =>
                entry.StartsWith("PHI_MIXED_STAGE:", StringComparison.Ordinal))) Console.Error.WriteLine(marker.Trim());
            throw new InvalidDataException();
          }
          if (!outputPipe.Join(2000) || !errorPipe.Join(2000)) throw new InvalidDataException();
          readerGone = reader.HasExited;
          stage = "READER_EXIT";
          if (reader.ExitCode != 0) {
            string marker = (readerErrors ?? "").Split('\n').FirstOrDefault(entry =>
              entry.StartsWith("PHI_MIXED_JOURNAL_FIXTURE_READ_FAILED:", StringComparison.Ordinal));
            Console.Error.WriteLine(marker ?? "PHI_MIXED_JOURNAL_FIXTURE_READ_FAILED:NO_MARKER"); throw new InvalidDataException();
          }
          stage = "READER_OUTPUT";
          if (output == null || output.Length > 8192) throw new InvalidDataException();
          readerOutputBytes = Encoding.UTF8.GetByteCount(output);
          Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(output);
          stage = "READER_STATUS";
          string expectedStatus = name == "partial-after-real-modify" || stagedCreate || committedCreate && !userChangedB ? "UNKNOWN_FAIL_SAFE" : "CONFLICT";
          string expectedPhysical = stagedCreate ? "MANUAL_RECOVERY_REQUIRED" :
            name == "partial-after-real-modify" || committedCreate && !userChangedB ? "PARTIALLY_COMMITTED" : "CONFLICT";
          if ((string)observed["status"] != expectedStatus || (int)observed["projectMutations"] != 0 ||
              (int)observed["journalMutations"] != 0 || (bool)observed["projectPublished"]) throw new InvalidDataException();
          Dictionary<string, object> metadata = observed["metadata"] as Dictionary<string, object>;
          IList states = metadata["operationStates"] as IList;
          stage = "READER_METADATA";
          if (states == null || states.Count != 4 || (string)metadata["journalState"] != "PARTIAL_PROGRESS" ||
              (int)metadata["journalPendingOperations"] != (committedCreate ? 2 : 3) || (string)metadata["filesystemState"] != expectedPhysical ||
              (string)metadata["scope"] != "MIXED_JOURNAL_ONLY_NOT_VERIFIED_PUBLICATION" ||
              (string)((Dictionary<string, object>)states[0])["durablePhase"] != "FINALIZED" ||
              (string)((Dictionary<string, object>)states[1])["durablePhase"] != (stagedCreate ? "MUTATION_STARTED" : committedCreate ? "FINALIZED" : "PREPARED") ||
              (string)((Dictionary<string, object>)states[2])["durablePhase"] != (committedCreate ? "PREPARED" : "NOT_STARTED") ||
              (string)((Dictionary<string, object>)states[3])["durablePhase"] != "NOT_STARTED") throw new InvalidDataException();
          IList physical = observed["operationEvidence"] as IList;
          stage = "READER_PHYSICAL";
          if (physical == null || physical.Count != 4 ||
              (string)((Dictionary<string, object>)physical[0])["physicalState"] != (name == "partial-after-modify-journal-only" ? "CONFLICT" : "NEW_COMPLETE_OBSERVED") ||
              (string)((Dictionary<string, object>)physical[1])["physicalState"] != (stagedCreate ? "STAGED_COMPLETE_OBSERVED" : committedCreate ? userChangedB ? "CONFLICT" : "NEW_COMPLETE_OBSERVED" : "OLD_COMPLETE_OBSERVED") ||
              (string)((Dictionary<string, object>)physical[2])["physicalState"] != "OLD_COMPLETE_OBSERVED" ||
              (string)((Dictionary<string, object>)physical[3])["physicalState"] != (name == "partial-after-real-modify-user-e" ? "CONFLICT" : "OLD_COMPLETE_OBSERVED")) throw new InvalidDataException();
          evidence = new { status = observed["status"], journalState = metadata["journalState"],
            journalPendingOperations = metadata["journalPendingOperations"], filesystemState = metadata["filesystemState"],
            operationPhases = states.Cast<object>().Select(item => ((Dictionary<string, object>)item)["durablePhase"]).ToArray(),
            operationPhysicalStates = physical.Cast<object>().Select(item => ((Dictionary<string, object>)item)["physicalState"]).ToArray(),
            sequence = metadata["sequence"], projectMutations = observed["projectMutations"], journalMutations = observed["journalMutations"] };
        }
        snapshotUnchanged = !stagedCreate && Serializer().Serialize(Snapshot(scope.Root, rootId)) == before;
        if (snapshotUnchanged != (name == "partial-after-modify-journal-only") ||
            name != "partial-after-modify-journal-only" && (File.ReadAllText(Path.Combine(scope.Root, "a.txt")) != "a-new" ||
              (committedCreate ? File.ReadAllText(Path.Combine(scope.Root, "b.txt")) != (userChangedB ? "private-user-b-content" : "b-new") : File.Exists(Path.Combine(scope.Root, "b.txt"))) ||
              (name == "partial-after-real-modify-user-e" ? File.ReadAllText(Path.Combine(scope.Root, "e.txt")) != "private-user-e-content" : File.Exists(Path.Combine(scope.Root, "e.txt"))) ||
              stagedCreate && File.ReadAllText(Path.Combine(scope.Root, "phi-publish-" + tx + ".tmp")) != "b-new")) throw new InvalidDataException();
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_MIXED_JOURNAL_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8")); }
      finally {
        if (child != null) { try { if (!child.HasExited) { child.Kill(); child.WaitForExit(3000); } } finally { child.Dispose(); } }
        try { using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, actualPublisherKilled = killed, publisherGone = childGone,
        freshReaderGone = readerGone, fixtureCleanup = clean, snapshotUnchanged, readerOutputBytes, evidence,
        scope = name == "partial-after-modify-journal-only" ? "MIXED_JOURNAL_DURABILITY_ONLY_NO_PHYSICAL_PUBLICATION" :
          stagedCreate ? "MIXED_V5_STAGED_CREATE_NOT_MIXED_PUBLICATION" : committedCreate ?
          "MIXED_V5_PHYSICAL_MODIFY_CREATE_NOT_MIXED_PUBLICATION" : "MIXED_V5_SINGLE_PHYSICAL_MODIFY_NOT_MIXED_PUBLICATION",
        projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
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
      Dictionary<string, object> snapshot = Snapshot(project, (string)header["projectIdentity"]);
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"], ids = (Dictionary<string, object>)snapshot["identities"];
      Dictionary<string, object> desired = new Dictionary<string, object>(files); desired.Remove((string)op["path"]);
      header["baseDigest"] = ProjectBaseDigest((string)header["projectIdentity"], files, ids);
      header["verifiedDigest"] = ProjectDraftDigest(desired);
      return header;
    }
    static Dictionary<string, object> ModifyRecoveryFixtureHeader(string project, string transactionId) {
      Dictionary<string, object> header = FixtureHeader(project, transactionId); header["version"] = 2;
      Dictionary<string, object> snapshot = Snapshot(project, (string)header["projectIdentity"]);
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"];
      Dictionary<string, object> desired = new Dictionary<string, object>(files); desired["input.txt"] = "new-complete";
      header["baseDigest"] = ProjectBaseDigest((string)header["projectIdentity"], files,
        (Dictionary<string, object>)snapshot["identities"]);
      header["verifiedDigest"] = ProjectDraftDigest(desired);
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
    static string FixtureGit(string root, string arguments) {
      using (Process git = Process.Start(new ProcessStartInfo { FileName = "git", Arguments = arguments, WorkingDirectory = root,
        UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
        try {
          if (!git.WaitForExit(5000) || git.ExitCode != 0) throw new InvalidDataException();
          string output = git.StandardOutput.ReadToEnd();
          if (output.Length > 4096) throw new InvalidDataException();
          return output.Replace("\r\n", "\n").Trim();
        } finally { if (!git.HasExited) { git.Kill(); git.WaitForExit(3000); } }
      }
    }
    static void CleanupFixtureGit(string gitDirectory, string transactionId) {
      string expected = Path.Combine(Path.GetTempPath(), "phi-git-" + transactionId);
      if (!Id.IsMatch(transactionId) || !String.Equals(Path.GetFullPath(gitDirectory), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException();
      if (!Directory.Exists(gitDirectory)) return;
      int remaining = 256;
      Action<string, int> normalize = null;
      normalize = delegate(string current, int depth) {
        if (depth > 12) throw new InvalidDataException();
        foreach (string child in Directory.GetFileSystemEntries(current)) {
          if (--remaining < 0) throw new InvalidDataException();
          FileAttributes attributes = File.GetAttributes(child);
          if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
          if ((attributes & FileAttributes.Directory) != 0) normalize(child, depth + 1);
          else File.SetAttributes(child, FileAttributes.Normal);
        }
      };
      normalize(gitDirectory, 0);
      Directory.Delete(gitDirectory, true);
      if (Directory.Exists(gitDirectory)) throw new InvalidDataException();
    }
    internal static int DeleteControllerRecoverySelfTest(string name) {
      string[] cases = { "rollback", "rollback-intent", "metadata-rollback", "finalize", "cleanup-only", "conflict", "unrelated-change",
        "quarantine-replaced", "quarantine-content-changed", "manual", "invalid-locator" };
      if (!cases.Contains(name)) return 70;
      ScopeRecovery scope = null; Process publisher = null;
      string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN", phaseAtDeath = null;
      string gitDirectory = Path.Combine(Path.GetTempPath(), "phi-git-" + tx);
      bool passed = false, clean = false, gitMetadataClean = false, killed = false, childGone = false, controllerGone = false;
      object evidence = null, discoveryEvidence = null; int controllerExit = -1;
      string rootIdEvidence = null, sourceIdEvidence = null, unrelatedIdEvidence = null, baseDigestEvidence = null, verifiedDigestEvidence = null;
      string expectedFileDigestEvidence = null, quarantineIdentityAtDeath = null, quarantineIdentityAtRecovery = null, quarantineDigestAtRecovery = null;
      string gitDiffEvidence = null, retentionDecision = null;
      bool activeRetentionBlocked = false, pendingRetentionBlocked = false, heldCandidateBlocked = false, retentionKeyRemoved = false;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        string source = Path.Combine(scope.Root, "input.txt"), unrelated = Path.Combine(scope.Root, "unrelated.txt"), quarantine = Path.Combine(scope.Root, DeleteLeaf(tx));
        File.WriteAllText(source, "old-delete-complete", new UTF8Encoding(false));
        File.WriteAllText(unrelated, "unrelated-delete-user", new UTF8Encoding(false));
        if (Directory.Exists(gitDirectory) || File.Exists(gitDirectory)) throw new InvalidDataException();
        FixtureGit(scope.Root, "init -q --separate-git-dir \"" + gitDirectory + "\"");
        FixtureGit(scope.Root, "add -- input.txt unrelated.txt");
        FixtureGit(scope.Root, "-c user.name=Phi -c user.email=phi@example.invalid commit -qm baseline");
        if (FixtureGit(scope.Root, "status --porcelain") != "") throw new InvalidDataException();
        Dictionary<string, object> expectedHeader = DeleteFixtureHeader(scope.Root, tx);
        Dictionary<string, object> original = Snapshot(scope.Root, rootId);
        Dictionary<string, object> originalIds = (Dictionary<string, object>)original["identities"];
        rootIdEvidence = rootId; sourceIdEvidence = (string)originalIds["input.txt"]; unrelatedIdEvidence = (string)originalIds["unrelated.txt"];
        baseDigestEvidence = (string)expectedHeader["baseDigest"]; verifiedDigestEvidence = (string)expectedHeader["verifiedDigest"];
        expectedFileDigestEvidence = (string)((Dictionary<string, object>)Operations(expectedHeader)[0])["baseDigest"];
        string point = name == "metadata-rollback" || name == "invalid-locator" ? "intent" : name == "rollback-intent" ? "renamed" :
          name == "finalize" ? "unlinked" : name == "cleanup-only" ? "cleaned" : "quarantined";
        stage = "START_PUBLISHER";
        publisher = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-delete-fixture-child " + point, UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        publisher.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); publisher.StandardInput.Close();
        string ready = null; Thread reader = new Thread(delegate() { try { ready = publisher.StandardOutput.ReadLine(); } catch { } }); reader.IsBackground = true; reader.Start();
        if (!reader.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
        Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
        if (!(bool)announcement["ready"] || (string)announcement["checkpoint"] != point || (string)announcement["transactionId"] != tx) throw new InvalidDataException();
        if (name == "rollback") {
          try { RetentionFixturePressure(scope.Root, rootId, Guid.NewGuid().ToString("N")); }
          catch (InvalidOperationException error) { activeRetentionBlocked = error.Message == "PHI_PUBLICATION_CAPACITY_BLOCKED"; }
          if (!activeRetentionBlocked) throw new InvalidDataException();
        }
        phaseAtDeath = announcement["phase"] as string; stage = "KILL_PUBLISHER";
        publisher.Kill(); killed = true;
        if (!publisher.WaitForExit(3000) || !publisher.HasExited || publisher.ExitCode == 0) throw new InvalidDataException(); childGone = true;
        using (RecoveryFilesystem parent = new RecoveryFilesystem(scope.Root)) {
          DeleteObject held = ReadDeleteLeaf(parent, DeleteLeaf(tx));
          quarantineIdentityAtDeath = held == null ? null : held.Identity;
          if (held != null && (held.Identity != sourceIdEvidence || held.Digest != expectedFileDigestEvidence)) throw new InvalidDataException();
        }
        if (name == "rollback") {
          try { RetentionFixturePressure(scope.Root, rootId, Guid.NewGuid().ToString("N")); }
          catch (InvalidOperationException error) { pendingRetentionBlocked = error.Message == "PHI_PUBLICATION_CAPACITY_BLOCKED"; }
          if (!pendingRetentionBlocked || !File.Exists(quarantine)) throw new InvalidDataException();
        }
        if (name == "conflict") File.WriteAllText(source, "new-delete-user", new UTF8Encoding(false));
        if (name == "unrelated-change") File.WriteAllText(unrelated, "new-unrelated-user", new UTF8Encoding(false));
        if (name == "quarantine-replaced") { File.Move(quarantine, quarantine + ".user-owned"); File.WriteAllText(quarantine, "old-delete-complete", new UTF8Encoding(false)); }
        if (name == "quarantine-content-changed") File.WriteAllText(quarantine, "changed-delete-user", new UTF8Encoding(false));
        if (name == "manual") File.Move(quarantine, quarantine + ".user-owned");
        using (RecoveryFilesystem parent = new RecoveryFilesystem(scope.Root)) {
          DeleteObject held = ReadDeleteLeaf(parent, DeleteLeaf(tx));
          quarantineIdentityAtRecovery = held == null ? null : held.Identity;
          quarantineDigestAtRecovery = held == null ? null : held.Digest;
        }
        if (new string[] { "rollback", "conflict", "manual" }.Contains(name)) {
          stage = "FRESH_DISCOVERY";
          using (Process discovery = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
            Arguments = "--publication-discover", UseShellExecute = false, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
            try {
              discovery.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root })); discovery.StandardInput.Close();
              if (!discovery.WaitForExit(5000) || discovery.ExitCode != 0) throw new InvalidDataException();
              string output = discovery.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
              Dictionary<string, object> inventory = Serializer().Deserialize<Dictionary<string, object>>(output);
              IList entries = inventory["entries"] as IList;
              string expectedClass = name == "rollback" ? "RECOVERY_REQUIRED" : name == "conflict" ? "CONFLICT" : "MANUAL_RECOVERY_REQUIRED";
              if ((string)inventory["status"] != "PASS_READ_ONLY_DISCOVERY" || (string)inventory["rootIdentity"] != rootId ||
                  entries == null || entries.Count != 1 || (int)inventory["projectTransactions"] != 1 ||
                  (bool)inventory["actionPerformed"] || (int)inventory["journalMutations"] != 0 || (int)inventory["projectMutations"] != 0 ||
                  (int)inventory["processKills"] != 0 || (bool)inventory["projectPublished"]) throw new InvalidDataException();
              Dictionary<string, object> entry = entries[0] as Dictionary<string, object>;
              if (entry == null || (string)entry["transactionId"] != tx || (int)entry["journalVersion"] != 3 ||
                  (string)entry["classification"] != expectedClass) throw new InvalidDataException();
              discoveryEvidence = inventory;
            } finally { if (!discovery.HasExited) { discovery.Kill(); discovery.WaitForExit(3000); } }
          }
        }
        stage = "NEW_CONTROLLER";
        using (Process controller = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-recover-known", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
          try {
            controller.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root,
              transactionId = name == "invalid-locator" ? Guid.NewGuid().ToString("N") : tx,
              guardianPid = Process.GetCurrentProcess().Id, timeoutMs = 10000 })); controller.StandardInput.Close();
            if (!controller.WaitForExit(5000)) throw new InvalidDataException(); controllerGone = controller.HasExited; controllerExit = controller.ExitCode;
            if (controllerExit != (name == "invalid-locator" ? 70 : 0)) throw new InvalidDataException();
            string output = controller.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
            Dictionary<string, object> receipt = Serializer().Deserialize<Dictionary<string, object>>(output); evidence = receipt;
            if (name == "invalid-locator") {
              if ((string)receipt["status"] != "FAIL_BOUNDED_RENAME_RECOVERY" || (bool)receipt["actionPerformed"] ||
                  (bool)receipt["projectPublished"] || (int)receipt["projectMutations"] != 0) throw new InvalidDataException();
            } else {
              string decision = name == "cleanup-only" ? "CLEANUP_ONLY" :
                new string[] { "conflict", "unrelated-change", "quarantine-replaced", "quarantine-content-changed" }.Contains(name) ? "CONFLICT" :
                name == "manual" ? "MANUAL_RECOVERY_REQUIRED" : name == "finalize" ? "FINALIZE_COMMIT" : "ROLLBACK";
              bool action = new string[] { "rollback", "rollback-intent", "metadata-rollback", "finalize", "conflict", "unrelated-change",
                "quarantine-replaced", "quarantine-content-changed" }.Contains(name);
              string finalPhase = decision == "ROLLBACK" ? "ROLLED_BACK" : decision == "CONFLICT" ? "CONFLICT" :
                decision == "FINALIZE_COMMIT" || decision == "CLEANUP_ONLY" ? "CLEANED" : phaseAtDeath;
              if ((string)receipt["status"] != "PASS_BOUNDED_DELETE_RECOVERY" || (string)receipt["decision"] != decision ||
                  (string)receipt["transactionId"] != tx || (string)receipt["rootIdentity"] != rootId || !(bool)receipt["rootIdentityVerified"] ||
                  (string)receipt["phaseBefore"] != phaseAtDeath || (string)receipt["phaseAfter"] != finalPhase ||
                  (bool)receipt["actionPerformed"] != action || ((int)receipt["journalMutations"] > 0) != action ||
                  (int)receipt["projectMutations"] != (name == "rollback" || name == "rollback-intent" ? 1 : 0) ||
                  (int)receipt["processKills"] != 0 || (bool)receipt["projectPublished"] || (int)receipt["externalRequests"] != 0 ||
                  (bool)receipt["baseDigestVerified"] != !new string[] { "conflict", "unrelated-change", "quarantine-replaced", "quarantine-content-changed",
                    "manual", "finalize", "cleanup-only" }.Contains(name) ||
                  (bool)receipt["verifiedDraftDigestMatched"] != !new string[] { "conflict", "unrelated-change", "quarantine-replaced",
                    "quarantine-content-changed", "manual" }.Contains(name)) throw new InvalidDataException();
            }
          } finally { if (!controller.HasExited) { controller.Kill(); controller.WaitForExit(3000); } }
        }
        stage = "VERIFY_PROJECT_AND_JOURNAL";
        bool restored = new string[] { "rollback", "rollback-intent", "metadata-rollback", "invalid-locator" }.Contains(name);
        bool foreignSource = name == "conflict";
        if (File.Exists(source) != (restored || foreignSource) ||
            File.Exists(quarantine) != new string[] { "conflict", "unrelated-change", "quarantine-replaced", "quarantine-content-changed" }.Contains(name) ||
            File.ReadAllText(unrelated) != (name == "unrelated-change" ? "new-unrelated-user" : "unrelated-delete-user") ||
            restored && File.ReadAllText(source) != "old-delete-complete" ||
            foreignSource && File.ReadAllText(source) != "new-delete-user" ||
            name == "manual" && File.ReadAllText(quarantine + ".user-owned") != "old-delete-complete" ||
            name == "quarantine-replaced" && (File.ReadAllText(quarantine + ".user-owned") != "old-delete-complete" ||
              File.ReadAllText(quarantine) != "old-delete-complete") ||
            name == "quarantine-content-changed" && File.ReadAllText(quarantine) != "changed-delete-user") throw new InvalidDataException();
        string gitDiff = FixtureGit(scope.Root, "diff --name-only"); gitDiffEvidence = gitDiff;
        string expectedDiff = restored ? "" : name == "conflict" ? "input.txt" : name == "unrelated-change" ? "input.txt\nunrelated.txt" :
          new string[] { "finalize", "cleanup-only", "quarantine-replaced", "quarantine-content-changed", "manual" }.Contains(name) ? "input.txt" : "";
        if (FixtureGit(scope.Root, "rev-parse --is-inside-work-tree") != "true" || gitDiff != expectedDiff ||
            restored && FixtureGit(scope.Root, "status --porcelain") != "") throw new InvalidDataException();
        using (PublicationJournal journal = new PublicationJournal(tx, scope.Root)) using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx, false)) {
          if (key == null) throw new InvalidDataException(); journal.ReadChain(key);
          if ((string)journal.header["baseDigest"] != (string)expectedHeader["baseDigest"] ||
              (string)journal.header["verifiedDigest"] != (string)expectedHeader["verifiedDigest"] ||
              (string)journal.last["phase"] != (restored && name != "invalid-locator" ? "ROLLED_BACK" : name == "finalize" || name == "cleanup-only" ? "CLEANED" :
                new string[] { "conflict", "unrelated-change", "quarantine-replaced", "quarantine-content-changed" }.Contains(name) ? "CONFLICT" : phaseAtDeath)) throw new InvalidDataException();
        }
        stage = "RETENTION_PRESSURE";
        bool safeTerminal = new string[] { "rollback", "rollback-intent", "metadata-rollback", "finalize", "cleanup-only" }.Contains(name);
        if (name == "rollback") {
          // A second controller holds the exact candidate lease. Admission
          // must skip it even though its terminal filesystem proof is valid.
          ManualResetEvent heldReady = new ManualResetEvent(false), releaseHeld = new ManualResetEvent(false);
          Exception holderFailure = null;
          Thread holder = new Thread(delegate() {
            try { using (PublicationJournal occupied = new PublicationJournal(tx, scope.Root)) {
              heldReady.Set(); releaseHeld.WaitOne();
            } } catch (Exception holderException) { holderFailure = holderException; heldReady.Set(); }
          });
          holder.IsBackground = true; holder.Start();
          try {
            if (!heldReady.WaitOne(5000) || holderFailure != null) throw new InvalidDataException();
            try { RetentionFixturePressure(scope.Root, rootId, Guid.NewGuid().ToString("N")); }
            catch (InvalidOperationException error) { heldCandidateBlocked = error.Message == "PHI_PUBLICATION_CAPACITY_BLOCKED"; }
            using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx, false))
              if (!heldCandidateBlocked || key == null) throw new InvalidDataException();
          } finally {
            releaseHeld.Set();
            if (!holder.Join(5000)) throw new InvalidDataException();
            heldReady.Dispose(); releaseHeld.Dispose();
          }
        }
        try { retentionDecision = RetentionFixturePressure(scope.Root, rootId, Guid.NewGuid().ToString("N")); }
        catch (InvalidOperationException error) {
          if (error.Message != "PHI_PUBLICATION_CAPACITY_BLOCKED") throw;
          retentionDecision = "CAPACITY_BLOCKED";
        }
        using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx, false)) retentionKeyRemoved = key == null;
        if (retentionKeyRemoved != safeTerminal || retentionDecision != (safeTerminal ? "RECLAIMED_TERMINAL" : "CAPACITY_BLOCKED") ||
            !safeTerminal && File.Exists(quarantine) != new string[] { "conflict", "unrelated-change", "quarantine-replaced", "quarantine-content-changed" }.Contains(name))
          throw new InvalidDataException();
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_DELETE_CONTROLLER_RECOVERY_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8") + ":controllerExit=" + controllerExit); }
      finally {
        if (publisher != null) { try { if (!publisher.HasExited) { publisher.Kill(); publisher.WaitForExit(3000); } } finally { publisher.Dispose(); } }
        try { CleanupFixtureGit(gitDirectory, tx); gitMetadataClean = true; } catch { gitMetadataClean = false; }
        try { using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean && gitMetadataClean, gitMetadataClean,
        actualProcessKilled = killed, childGone,
        restartedControllerGone = controllerGone, controllerExit, journalPhaseAtInterruption = phaseAtDeath, evidence, discoveryEvidence,
        rootIdentity = rootIdEvidence, sourceIdentity = sourceIdEvidence, unrelatedIdentity = unrelatedIdEvidence,
        baseDigest = baseDigestEvidence, verifiedDigest = verifiedDigestEvidence, expectedFileDigest = expectedFileDigestEvidence,
        quarantineIdentityAtDeath, quarantineIdentityAtRecovery, quarantineDigestAtRecovery, gitDiff = gitDiffEvidence,
        retentionDecision, retentionKeyRemoved, activeRetentionBlocked, pendingRetentionBlocked, heldCandidateBlocked,
        scope = "NATIVE_BOUNDED_DELETE_RECOVERY_NOT_RESTORED_PUBLICATION", projectPublished = false, externalRequests = 0 }));
      return passed && clean && gitMetadataClean ? 0 : 70;
    }
    static readonly string[] RenameCheckpoints = { "before-rename", "intent", "renamed", "journal-renamed", "committed", "verified", "cleaned" };
    static Dictionary<string, object> RenameFixtureHeader(string project, string transactionId) {
      Dictionary<string, object> header = FixtureHeader(project, transactionId); header["version"] = 4;
      Dictionary<string, object> op = (Dictionary<string, object>)Operations(header)[0];
      op["sourcePath"] = "input.txt"; op["path"] = "renamed.txt"; op["kind"] = "RENAME";
      op["newDigest"] = op["baseDigest"];
      op["newBytes"] = Encoding.UTF8.GetByteCount("old-rename-complete");
      Dictionary<string, object> snapshot = Snapshot(project, (string)header["projectIdentity"]);
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"], ids = (Dictionary<string, object>)snapshot["identities"];
      Dictionary<string, object> desired = new Dictionary<string, object>(files);
      desired.Remove("input.txt"); desired.Add("renamed.txt", files["input.txt"]);
      header["baseDigest"] = ProjectBaseDigest((string)header["projectIdentity"], files, ids);
      header["verifiedDigest"] = ProjectDraftDigest(desired);
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
    static Dictionary<string, object> RunNormalPhiStartup(string project, out bool exited, out int exitCode, out string terminalError) {
      // Fixed native fixture calls the ordinary user-facing CLI. Its cwd is
      // the owned Git project; no test-only recovery endpoint is substituted.
      string entry = Path.Combine(Environment.CurrentDirectory, "bin", "phi.mjs");
      if (!File.Exists(entry)) throw new InvalidDataException();
      using (Process startup = Process.Start(new ProcessStartInfo { FileName = "node", Arguments = "\"" + entry + "\"",
        WorkingDirectory = project, UseShellExecute = false, RedirectStandardOutput = true,
        RedirectStandardError = true, CreateNoWindow = true })) {
        try {
          if (!startup.WaitForExit(45000)) throw new InvalidDataException();
          exited = startup.HasExited; exitCode = startup.ExitCode;
          string stdout = startup.StandardOutput.ReadToEnd(), stderr = startup.StandardError.ReadToEnd();
          if (stdout.Length != 0 || stderr.Length > 8192 || exitCode != 1) throw new InvalidDataException();
          string[] lines = stderr.Replace("\r\n", "\n").Trim().Split('\n');
          if (lines.Length != 2 || !lines[0].StartsWith("PHI_STARTUP_RECOVERY ", StringComparison.Ordinal)) throw new InvalidDataException();
          terminalError = lines[1];
          Dictionary<string, object> receipt = Serializer().Deserialize<Dictionary<string, object>>(lines[0].Substring("PHI_STARTUP_RECOVERY ".Length));
          if ((int)receipt["version"] != 1 || (string)receipt["scope"] != "PHI_WINDOWS_STARTUP_RECOVERY_ONLY_NOT_PUBLICATION" ||
              (bool)receipt["projectPublished"] || (int)receipt["externalRequests"] != 0) throw new InvalidDataException();
          return receipt;
        } finally { if (!startup.HasExited) { startup.Kill(); startup.WaitForExit(3000); } }
      }
    }
    internal static int StartupRecoverySelfTest(string name) {
      if (!new string[] { "resume", "conflict", "manual" }.Contains(name)) return 70;
      ScopeRecovery scope = null; Process publisher = null;
      string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN", gitDirectory = Path.Combine(Path.GetTempPath(), "phi-git-" + tx);
      bool passed = false, clean = false, gitClean = false, killed = false, childGone = false, firstGone = false, secondGone = false, idempotent = false;
      int firstExit = -1, secondExit = -1; object firstReceipt = null, secondReceipt = null;
      string phaseAtDeath = null, gitDiff = null, rootIdEvidence = null;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root); rootIdEvidence = rootId;
        string source = Path.Combine(scope.Root, "input.txt"), target = Path.Combine(scope.Root, "renamed.txt"), unrelated = Path.Combine(scope.Root, "unrelated.txt");
        File.WriteAllText(source, "old-rename-complete", new UTF8Encoding(false));
        File.WriteAllText(unrelated, "unrelated-rename-user", new UTF8Encoding(false));
        if (Directory.Exists(gitDirectory) || File.Exists(gitDirectory)) throw new InvalidDataException();
        FixtureGit(scope.Root, "init -q --separate-git-dir \"" + gitDirectory + "\"");
        FixtureGit(scope.Root, "add -- input.txt unrelated.txt");
        FixtureGit(scope.Root, "-c user.name=Phi -c user.email=phi@example.invalid commit -qm baseline");
        if (FixtureGit(scope.Root, "status --porcelain") != "") throw new InvalidDataException();
        string point = name == "resume" ? "intent" : "renamed";
        stage = "START_PUBLISHER";
        publisher = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-rename-fixture-child " + point, UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        publisher.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); publisher.StandardInput.Close();
        string ready = null; Thread reader = new Thread(delegate() { try { ready = publisher.StandardOutput.ReadLine(); } catch { } }); reader.IsBackground = true; reader.Start();
        if (!reader.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
        Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
        if (!(bool)announcement["ready"] || (string)announcement["checkpoint"] != point || (string)announcement["transactionId"] != tx) throw new InvalidDataException();
        phaseAtDeath = announcement["phase"] as string;
        stage = "KILL_PUBLISHER"; publisher.Kill(); killed = true;
        if (!publisher.WaitForExit(3000) || !publisher.HasExited || publisher.ExitCode == 0) throw new InvalidDataException(); childGone = true;
        if (name == "conflict") File.WriteAllText(source, "new-rename-user", new UTF8Encoding(false));
        if (name == "manual") File.Move(target, target + ".user-owned");
        stage = "NORMAL_PHI_STARTUP";
        string firstError, secondError;
        Dictionary<string, object> first = RunNormalPhiStartup(scope.Root, out firstGone, out firstExit, out firstError); firstReceipt = first;
        string expectedStatus = name == "resume" ? "PASS_RECOVERED" : "BLOCKED";
        string expectedReason = name == "resume" ? "RESUME" : name == "conflict" ? "BLOCKED_CONFLICT" : "BLOCKED_MANUAL_RECOVERY_REQUIRED";
        if (!firstGone || (string)first["status"] != expectedStatus || (string)first["reason"] != expectedReason ||
            (string)first["rootIdentity"] != rootId || (string)first["transactionId"] != tx ||
            (int)first["journalVersion"] != 4 || (int)first["projectMutations"] != (name == "resume" ? 1 : 0) ||
            (int)first["journalMutations"] != (name == "resume" ? 4 : 0) ||
            firstError != (name == "resume" ? "PHI_SANDBOX_UNAVAILABLE: native Windows isolation is not yet verified; engine execution is blocked" :
              "PHI_STARTUP_RECOVERY_BLOCKED")) throw new InvalidDataException();
        int sequence;
        using (PublicationJournal journal = new PublicationJournal(tx, scope.Root)) using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx, false)) {
          if (key == null) throw new InvalidDataException(); journal.ReadChain(key);
          if ((string)journal.last["phase"] != (name == "resume" ? "CLEANED" : phaseAtDeath)) throw new InvalidDataException();
          sequence = (int)journal.last["sequence"];
        }
        string firstProject = Serializer().Serialize(Snapshot(scope.Root, rootId));
        stage = "SECOND_NORMAL_PHI_STARTUP";
        Dictionary<string, object> second = RunNormalPhiStartup(scope.Root, out secondGone, out secondExit, out secondError); secondReceipt = second;
        if (!secondGone || (string)second["status"] != (name == "resume" ? "PASS_NO_PENDING" : "BLOCKED") ||
            (int)second["projectMutations"] != 0 || (int)second["journalMutations"] != 0 ||
            secondError != (name == "resume" ? "PHI_SANDBOX_UNAVAILABLE: native Windows isolation is not yet verified; engine execution is blocked" :
              "PHI_STARTUP_RECOVERY_BLOCKED") || Serializer().Serialize(Snapshot(scope.Root, rootId)) != firstProject) throw new InvalidDataException();
        using (PublicationJournal journal = new PublicationJournal(tx, scope.Root)) using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx, false)) {
          if (key == null) throw new InvalidDataException(); journal.ReadChain(key);
          idempotent = (int)journal.last["sequence"] == sequence;
        }
        gitDiff = FixtureGit(scope.Root, "diff --name-only --no-renames");
        if (!idempotent || FixtureGit(scope.Root, "diff --check") != "" || gitDiff != "input.txt" ||
            File.Exists(source) != (name == "conflict") || File.Exists(target) != (name != "manual") ||
            name == "conflict" && File.ReadAllText(source) != "new-rename-user" ||
            name == "manual" && File.ReadAllText(target + ".user-owned") != "old-rename-complete") throw new InvalidDataException();
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_STARTUP_RECOVERY_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8") + ":firstExit=" + firstExit + ":secondExit=" + secondExit); }
      finally {
        if (publisher != null) { try { if (!publisher.HasExited) { publisher.Kill(); publisher.WaitForExit(3000); } } finally { publisher.Dispose(); } }
        try { CleanupFixtureGit(gitDirectory, tx); gitClean = true; } catch { gitClean = false; }
        try { using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean && gitClean, gitMetadataClean = gitClean,
        actualProcessKilled = killed, childGone, firstStartupGone = firstGone, secondStartupGone = secondGone,
        firstExit, secondExit, phaseAtDeath, firstReceipt, secondReceipt, idempotent, gitDiff, rootIdentity = rootIdEvidence,
        scope = "NORMAL_PHI_WINDOWS_STARTUP_RECOVERY_NOT_AUTONOMY", projectPublished = false, externalRequests = 0 }));
      return passed && clean && gitClean ? 0 : 70;
    }
    internal static int RenameControllerRecoverySelfTest(string name) {
      string[] cases = { "rollback", "resume", "resume-journal", "finalize", "cleanup-only", "conflict", "unrelated-change", "source-replaced", "manual", "invalid-locator" };
      if (!cases.Contains(name)) return 70;
      ScopeRecovery scope = null; Process publisher = null;
      string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN", phaseAtDeath = null;
      string rootIdEvidence = null, sourceIdEvidence = null, unrelatedIdEvidence = null, baseDigestEvidence = null, verifiedDigestEvidence = null;
      bool passed = false, clean = false, killed = false, childGone = false, controllerGone = false;
      object evidence = null, discoveryEvidence = null; int controllerExit = -1;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        string source = Path.Combine(scope.Root, "input.txt"), target = Path.Combine(scope.Root, "renamed.txt"), unrelated = Path.Combine(scope.Root, "unrelated.txt");
        File.WriteAllText(source, "old-rename-complete", new UTF8Encoding(false));
        File.WriteAllText(unrelated, "unrelated-rename-user", new UTF8Encoding(false));
        Dictionary<string, object> expectedHeader = RenameFixtureHeader(scope.Root, tx);
        Dictionary<string, object> initial = Snapshot(scope.Root, rootId);
        Dictionary<string, object> initialIds = (Dictionary<string, object>)initial["identities"];
        rootIdEvidence = rootId; sourceIdEvidence = (string)initialIds["input.txt"]; unrelatedIdEvidence = (string)initialIds["unrelated.txt"];
        baseDigestEvidence = (string)expectedHeader["baseDigest"]; verifiedDigestEvidence = (string)expectedHeader["verifiedDigest"];
        string point = name == "rollback" || name == "invalid-locator" ? "before-rename" :
          new string[] { "resume", "unrelated-change", "source-replaced" }.Contains(name) ? "intent" :
          name == "finalize" ? "committed" : name == "cleanup-only" ? "cleaned" : "renamed";
        stage = "START_PUBLISHER";
        publisher = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-rename-fixture-child " + point, UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        publisher.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx })); publisher.StandardInput.Close();
        string ready = null; Thread reader = new Thread(delegate() { try { ready = publisher.StandardOutput.ReadLine(); } catch { } }); reader.IsBackground = true; reader.Start();
        if (!reader.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
        Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
        if (!(bool)announcement["ready"] || (string)announcement["checkpoint"] != point || (string)announcement["transactionId"] != tx) throw new InvalidDataException();
        phaseAtDeath = announcement["phase"] as string; stage = "KILL_PUBLISHER";
        publisher.Kill(); killed = true; if (!publisher.WaitForExit(3000) || !publisher.HasExited || publisher.ExitCode == 0) throw new InvalidDataException(); childGone = true;
        if (name == "conflict") File.WriteAllText(source, "new-rename-user", new UTF8Encoding(false));
        if (name == "unrelated-change") File.WriteAllText(unrelated, "new-unrelated-user", new UTF8Encoding(false));
        if (name == "source-replaced") { File.Move(source, source + ".user-owned"); File.WriteAllText(source, "old-rename-complete", new UTF8Encoding(false)); }
        if (name == "manual") File.Move(target, target + ".user-owned");
        if (new string[] { "resume", "conflict", "manual" }.Contains(name)) {
          stage = "FRESH_DISCOVERY";
          using (Process discovery = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
            Arguments = "--publication-discover", UseShellExecute = false, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
            try {
              discovery.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root })); discovery.StandardInput.Close();
              if (!discovery.WaitForExit(5000) || discovery.ExitCode != 0) throw new InvalidDataException();
              string output = discovery.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
              Dictionary<string, object> inventory = Serializer().Deserialize<Dictionary<string, object>>(output);
              IList entries = inventory["entries"] as IList;
              if ((string)inventory["status"] != "PASS_READ_ONLY_DISCOVERY" || (string)inventory["rootIdentity"] != rootId ||
                  entries == null || entries.Count != 1 || (int)inventory["projectTransactions"] != 1 ||
                  (bool)inventory["actionPerformed"] || (int)inventory["journalMutations"] != 0 ||
                  (int)inventory["projectMutations"] != 0 || (int)inventory["processKills"] != 0 ||
                  (bool)inventory["projectPublished"]) throw new InvalidDataException();
              Dictionary<string, object> entry = entries[0] as Dictionary<string, object>;
              string expectedClass = name == "resume" ? "RECOVERY_REQUIRED" : name == "conflict" ? "CONFLICT" : "MANUAL_RECOVERY_REQUIRED";
              if (entry == null || (string)entry["transactionId"] != tx || (int)entry["journalVersion"] != 4 ||
                  (string)entry["classification"] != expectedClass) throw new InvalidDataException();
              discoveryEvidence = inventory;
            } finally { if (!discovery.HasExited) { discovery.Kill(); discovery.WaitForExit(3000); } }
          }
        }
        stage = "NEW_CONTROLLER";
        using (Process controller = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-recover-known", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
          try {
            controller.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root,
              transactionId = name == "invalid-locator" ? Guid.NewGuid().ToString("N") : tx,
              guardianPid = Process.GetCurrentProcess().Id, timeoutMs = 10000 })); controller.StandardInput.Close();
            if (!controller.WaitForExit(5000)) throw new InvalidDataException(); controllerGone = controller.HasExited; controllerExit = controller.ExitCode;
            if (controllerExit != (name == "invalid-locator" ? 70 : 0)) throw new InvalidDataException();
            string output = controller.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
            Dictionary<string, object> receipt = Serializer().Deserialize<Dictionary<string, object>>(output); evidence = receipt;
            if (name == "invalid-locator") {
              if ((string)receipt["status"] != "FAIL_BOUNDED_RENAME_RECOVERY" || (bool)receipt["actionPerformed"] ||
                  (bool)receipt["projectPublished"] || (int)receipt["projectMutations"] != 0) throw new InvalidDataException();
            } else {
              string decision = name == "cleanup-only" ? "CLEANUP_ONLY" : new string[] { "conflict", "unrelated-change", "source-replaced" }.Contains(name) ? "CONFLICT" :
                name == "manual" ? "MANUAL_RECOVERY_REQUIRED" : name == "finalize" ? "FINALIZE_COMMIT" :
                name == "resume-journal" ? "RESUME" : name.ToUpperInvariant();
              bool action = name == "rollback" || name == "resume" || name == "resume-journal" || name == "finalize";
              string finalPhase = name == "rollback" ? "ROLLED_BACK" : action || name == "cleanup-only" ? "CLEANED" : phaseAtDeath;
              if ((string)receipt["status"] != "PASS_BOUNDED_RENAME_RECOVERY" || (string)receipt["decision"] != decision ||
                  (string)receipt["transactionId"] != tx || (string)receipt["rootIdentity"] != rootId || !(bool)receipt["rootIdentityVerified"] ||
                  (string)receipt["phaseBefore"] != phaseAtDeath || (string)receipt["phaseAfter"] != finalPhase ||
                  (bool)receipt["actionPerformed"] != action || ((int)receipt["journalMutations"] > 0) != action ||
                  (int)receipt["projectMutations"] != (name == "resume" ? 1 : 0) || (int)receipt["processKills"] != 0 || (bool)receipt["projectPublished"] ||
                  (int)receipt["externalRequests"] != 0 ||
                  (bool)receipt["baseDigestVerified"] != !new string[] { "conflict", "unrelated-change", "source-replaced", "manual" }.Contains(name) ||
                  (bool)receipt["verifiedDraftDigestMatched"] != !new string[] { "conflict", "unrelated-change", "source-replaced", "manual" }.Contains(name)) throw new InvalidDataException();
            }
          } finally { if (!controller.HasExited) { controller.Kill(); controller.WaitForExit(3000); } }
        }
        stage = "VERIFY_PROJECT_AND_JOURNAL";
        if (File.ReadAllText(unrelated) != (name == "unrelated-change" ? "new-unrelated-user" : "unrelated-rename-user") ||
            File.Exists(source) != new string[] { "rollback", "invalid-locator", "conflict", "unrelated-change", "source-replaced" }.Contains(name) ||
            File.Exists(target) != !new string[] { "rollback", "invalid-locator", "unrelated-change", "source-replaced", "manual" }.Contains(name) ||
            name == "conflict" && File.ReadAllText(source) != "new-rename-user" ||
            name == "source-replaced" && (File.ReadAllText(source) != "old-rename-complete" || File.ReadAllText(source + ".user-owned") != "old-rename-complete") ||
            name == "manual" && File.ReadAllText(target + ".user-owned") != "old-rename-complete" ||
            !new string[] { "conflict", "manual", "unrelated-change", "source-replaced" }.Contains(name) &&
              File.ReadAllText(name == "rollback" || name == "invalid-locator" ? source : target) != "old-rename-complete") throw new InvalidDataException();
        using (PublicationJournal journal = new PublicationJournal(tx, scope.Root)) using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx, false)) {
          if (key == null) throw new InvalidDataException(); journal.ReadChain(key);
          if ((string)journal.header["baseDigest"] != (string)expectedHeader["baseDigest"] ||
              (string)journal.header["verifiedDigest"] != (string)expectedHeader["verifiedDigest"] ||
              (string)journal.last["phase"] != (name == "rollback" ? "ROLLED_BACK" : new string[] { "resume", "resume-journal", "finalize", "cleanup-only" }.Contains(name) ? "CLEANED" : phaseAtDeath)) throw new InvalidDataException();
        }
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_RENAME_CONTROLLER_RECOVERY_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8") + ":controllerExit=" + controllerExit); }
      finally {
        if (publisher != null) { try { if (!publisher.HasExited) { publisher.Kill(); publisher.WaitForExit(3000); } } finally { publisher.Dispose(); } }
        try { using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean, actualProcessKilled = killed, childGone,
        restartedControllerGone = controllerGone, controllerExit, journalPhaseAtInterruption = phaseAtDeath, evidence, discoveryEvidence,
        rootIdentity = rootIdEvidence, sourceIdentity = sourceIdEvidence, unrelatedIdentity = unrelatedIdEvidence,
        baseDigest = baseDigestEvidence, verifiedDigest = verifiedDigestEvidence,
        digestContractVector = ProjectDraftDigest(new Dictionary<string, object> { { "sample.txt", "A/\b\t\n\r\f\"\\<>&\u00e9\ud83d\ude00\u2028" } }),
        scope = "NATIVE_BOUNDED_RENAME_RECOVERY_NOT_RESTORED_PUBLICATION", projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
    }
    internal static int DiscoverySelfTest(string name) {
      if (!new string[] { "empty", "foreign", "active", "corrupt" }.Contains(name)) return 70;
      ScopeRecovery scope = null, foreign = null; PublicationJournal held = null; Process reader = null;
      string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN", rootIdentity = null;
      bool passed = false, clean = false, readerGone = false, retentionBlocked = false, ownedKeyPreserved = false;
      object evidence = null; int exit = -1;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        rootIdentity = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        string journalRoot = scope.Root;
        if (name == "foreign") {
          foreign = ScopeRecovery.Begin(); foreign.CreateRoot(); foreign.Ready(); journalRoot = foreign.Root;
        }
        if (name != "empty") {
          File.WriteAllText(Path.Combine(journalRoot, "input.txt"), "old-rename-complete", new UTF8Encoding(false));
          File.WriteAllText(Path.Combine(journalRoot, "unrelated.txt"), "unrelated-rename-user", new UTF8Encoding(false));
          held = Begin(journalRoot, RenameFixtureHeader(journalRoot, tx));
          if (name != "active" && name != "foreign") { held.Dispose(); held = null; }
          if (name == "corrupt") {
            // Only this fresh owned fixture key is damaged; never touch user
            // transaction evidence or production keys.
            using (RegistryKey root = OpenBase(true)) using (RegistryKey key = root.OpenSubKey(tx, true)) {
              if (key == null) throw new InvalidDataException(); ScopeRecovery.ValidateRegistry(key);
              key.SetValue("E00000000", new byte[] { 1, 2, 3 }, RegistryValueKind.Binary);
              if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
            }
          }
        }
        stage = "FRESH_READER";
        reader = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-discover", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        reader.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root })); reader.StandardInput.Close();
        if (!reader.WaitForExit(5000)) throw new InvalidDataException(); readerGone = reader.HasExited; exit = reader.ExitCode;
        if (exit != (name == "corrupt" ? 70 : 0)) throw new InvalidDataException();
        string output = reader.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
        Dictionary<string, object> receipt = Serializer().Deserialize<Dictionary<string, object>>(output); evidence = receipt;
        if ((bool)receipt["actionPerformed"] || (int)receipt["journalMutations"] != 0 || (int)receipt["projectMutations"] != 0 ||
            (int)receipt["processKills"] != 0 || (bool)receipt["projectPublished"] || (int)receipt["externalRequests"] != 0) throw new InvalidDataException();
        if (name == "corrupt") {
          if ((string)receipt["status"] != "FAIL_READ_ONLY_DISCOVERY" || (string)receipt["decision"] != "UNKNOWN_FAIL_SAFE" ||
              receipt.ContainsKey("entries")) throw new InvalidDataException();
        } else {
          IList entries = receipt["entries"] as IList;
          if ((string)receipt["status"] != "PASS_READ_ONLY_DISCOVERY" || (string)receipt["rootIdentity"] != rootIdentity ||
              !(bool)receipt["rootIdentityVerified"] || entries == null ||
              (int)receipt["projectTransactions"] != (name == "active" ? 1 : 0) || entries.Count != (name == "active" ? 1 : 0)) throw new InvalidDataException();
          if (name == "active") {
            Dictionary<string, object> entry = entries[0] as Dictionary<string, object>;
            if (entry == null || (string)entry["transactionId"] != tx || (int)entry["journalVersion"] != 4 ||
                (string)entry["phase"] != "UNKNOWN_ACTIVE" || (string)entry["observedStatus"] != "ACTIVE" ||
                (string)entry["classification"] != "ACTIVE_UNVERIFIED") throw new InvalidDataException();
          }
        }
        if (name == "active" || name == "corrupt") {
          stage = "RETENTION_FAIL_CLOSED";
          try { RetentionFixturePressure(scope.Root, rootIdentity, Guid.NewGuid().ToString("N")); }
          catch (InvalidOperationException error) { retentionBlocked = name == "active" && error.Message == "PHI_PUBLICATION_CAPACITY_BLOCKED"; }
          catch (InvalidDataException) { retentionBlocked = name == "corrupt"; }
          using (RegistryKey root = OpenBase(false)) using (RegistryKey key = root.OpenSubKey(tx, false)) ownedKeyPreserved = key != null;
          if (!retentionBlocked || !ownedKeyPreserved) throw new InvalidDataException();
        }
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_DISCOVERY_SELFTEST_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8") + ":exit=" + exit); }
      finally {
        if (reader != null) { try { if (!reader.HasExited) { reader.Kill(); reader.WaitForExit(3000); } } finally { reader.Dispose(); } }
        if (held != null) held.Dispose();
        try {
          using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          bool foreignRemoved = true;
          if (foreign != null) { foreign.CleanupFiles(); foreignRemoved = !Directory.Exists(foreign.Root); foreign.Complete(foreignRemoved); }
          if (scope != null) { scope.CleanupFiles(); bool scopeRemoved = !Directory.Exists(scope.Root); scope.Complete(scopeRemoved); clean = foreignRemoved && scopeRemoved; }
        } catch { clean = false; if (foreign != null) foreign.Dispose(); if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean, readerGone, readerExit = exit,
        retentionBlocked, ownedKeyPreserved,
        rootIdentity, evidence, scope = "NATIVE_READ_ONLY_PHI_INDEX_DISCOVERY_NOT_RECOVERY_AUTHORITY",
        projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
    }
    internal static int RetentionCapacitySelfTest() {
      // Separate native gate: the real 64-entry index is filled only with
      // fresh fixture IDs and every one of those IDs is removed on exit.
      ScopeRecovery terminal = null, active = null; Process publisher = null, reader = null;
      List<string> owned = new List<string>(); string stage = "BEGIN", terminalId = Guid.NewGuid().ToString("N");
      string[] initialNames = null; bool passed = false, clean = false, killed = false, publisherGone = false, readerGone = false;
      bool noSafeBlocked = false, corruptBlocked = false, secondPassBlocked = false, terminalRemoved = false, admittedAfterReclaim = false;
      bool normal63To64 = false, otherEntriesPreserved = false, projectUnchanged = false, concurrentAdmissionSerialized = false;
      int filled = 0, beforeReclaim = -1, afterReclaim = -1;
      string lastFillerId = null;
      string beforeProjectDigest = null, afterProjectDigest = null, selectedTransactionId = null, terminalPhase = null;
      Dictionary<string, object> reclaimReceipt = null;
      try {
        using (RegistryKey registry = OpenBase(true)) initialNames = registry.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).ToArray();
        if (initialNames.Length >= MaxTransactions) throw new InvalidDataException();
        terminal = ScopeRecovery.Begin(); terminal.CreateRoot(); terminal.Ready();
        active = ScopeRecovery.Begin(); active.CreateRoot(); active.Ready();
        File.WriteAllText(Path.Combine(terminal.Root, "input.txt"), "old-delete-complete", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(terminal.Root, "unrelated.txt"), "unrelated-delete-user", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(active.Root, "input.txt"), "old-rename-complete", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(active.Root, "unrelated.txt"), "unrelated-rename-user", new UTF8Encoding(false));
        string terminalRootId = RecoveryFilesystem.DirectoryIdentity(terminal.Root);
        stage = "TERMINAL_PUBLISHER";
        owned.Add(terminalId);
        publisher = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-delete-fixture-child cleaned", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        publisher.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = terminal.Id, rootIdentity = terminalRootId, transactionId = terminalId }));
        publisher.StandardInput.Close();
        string ready = null; Thread readyReader = new Thread(delegate() { try { ready = publisher.StandardOutput.ReadLine(); } catch { } });
        readyReader.IsBackground = true; readyReader.Start();
        if (!readyReader.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
        Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
        if (!(bool)announcement["ready"] || (string)announcement["phase"] != "CLEANED" || (string)announcement["transactionId"] != terminalId) throw new InvalidDataException();
        publisher.Kill(); killed = true;
        if (!publisher.WaitForExit(3000) || !publisher.HasExited || publisher.ExitCode == 0) throw new InvalidDataException(); publisherGone = true;
        if (File.Exists(Path.Combine(terminal.Root, "input.txt")) || File.Exists(Path.Combine(terminal.Root, DeleteLeaf(terminalId)))) throw new InvalidDataException();

        stage = "FILL_REAL_CAPACITY";
        int needed = MaxTransactions - initialNames.Length - 1;
        for (int i = 0; i < needed; i++) {
          string id = Guid.NewGuid().ToString("N");
          owned.Add(id);
          lastFillerId = id;
          if (i == needed - 1) using (RegistryKey registry = OpenBase(false)) normal63To64 = registry.GetSubKeyNames().Length == 63;
          using (PublicationJournal filler = Begin(active.Root, FixtureHeader(active.Root, id))) { }
          filled++;
        }
        string[] fullNames;
        using (RegistryKey registry = OpenBase(false)) {
          fullNames = registry.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).ToArray();
          beforeReclaim = fullNames.Length;
        }
        if (!normal63To64 || beforeReclaim != MaxTransactions) throw new InvalidDataException();
        Dictionary<string, object> beforeTree = Snapshot(terminal.Root, terminalRootId);
        beforeProjectDigest = ProjectBaseDigest(terminalRootId, (Dictionary<string, object>)beforeTree["files"],
          (Dictionary<string, object>)beforeTree["identities"]);
        string blockedId = Guid.NewGuid().ToString("N");
        owned.Add(blockedId);
        try { using (PublicationJournal rejected = Begin(active.Root, FixtureHeader(active.Root, blockedId))) { } }
        catch (InvalidOperationException error) { noSafeBlocked = error.Message == "PHI_PUBLICATION_CAPACITY_BLOCKED"; }
        using (RegistryKey registry = OpenBase(false))
          if (!noSafeBlocked || !registry.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(fullNames)) throw new InvalidDataException();

        stage = "CORRUPT_CANDIDATE_FAIL_CLOSED";
        if (lastFillerId == null) throw new InvalidDataException();
        string corruptId = lastFillerId; byte[] originalEnvelope;
        using (RegistryKey registry = OpenBase(true)) using (RegistryKey key = registry.OpenSubKey(corruptId, true)) {
          if (key == null) throw new InvalidDataException();
          originalEnvelope = ReadValue(key, "E00000000");
          byte[] corruptEnvelope = (byte[])originalEnvelope.Clone(); corruptEnvelope[8] ^= 1;
          key.SetValue("E00000000", corruptEnvelope, RegistryValueKind.Binary);
          if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
        }
        try {
          string corruptAttempt = Guid.NewGuid().ToString("N"); owned.Add(corruptAttempt);
          try { using (PublicationJournal rejected = Begin(active.Root, FixtureHeader(active.Root, corruptAttempt))) { } }
          catch (InvalidDataException) { corruptBlocked = true; }
          using (RegistryKey registry = OpenBase(false))
            if (!corruptBlocked || !registry.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(fullNames)) throw new InvalidDataException();
        } finally {
          using (RegistryKey registry = OpenBase(true)) using (RegistryKey key = registry.OpenSubKey(corruptId, true)) {
            if (key == null) throw new InvalidDataException();
            key.SetValue("E00000000", originalEnvelope, RegistryValueKind.Binary);
            if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
          }
        }

        stage = "RECLAIM_ONE_TERMINAL";
        Dictionary<string, object> snapshot = Snapshot(terminal.Root, terminalRootId);
        Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"];
        Dictionary<string, object> draft = new Dictionary<string, object>(files); draft.Add("new.txt", "new-fixture");
        bool alive; int pid = Process.GetCurrentProcess().Id;
        string firstId = Guid.NewGuid().ToString("N"), secondId = Guid.NewGuid().ToString("N");
        owned.Add(firstId); owned.Add(secondId);
        Dictionary<string, object> header = new Dictionary<string, object> {
          { "version", 1 }, { "transactionId", firstId }, { "projectIdentity", terminalRootId }, { "draftId", Guid.NewGuid().ToString("N") },
          { "draftVersion", 1 }, { "verifiedDigest", ProjectDraftDigest(draft) },
          { "baseDigest", ProjectBaseDigest(terminalRootId, files, (Dictionary<string, object>)snapshot["identities"]) },
          { "creatorPid", pid }, { "creatorGeneration", ScopeRecovery.ProcessCreation(pid, out alive) },
          { "operations", new object[] { new Dictionary<string, object> { { "path", "new.txt" }, { "kind", "CREATE" },
            { "baseIdentity", null }, { "baseDigest", null }, { "newDigest", Hash(Encoding.UTF8.GetBytes("new-fixture")) }, { "newBytes", 11 } } } }
        };
        if (!alive) throw new InvalidDataException();
        Dictionary<string, object> competing = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(header));
        competing["transactionId"] = secondId;
        // Both real admissions start at the same 64-entry boundary. The
        // private admission mutex must grant precisely one reused slot.
        ManualResetEvent startGate = new ManualResetEvent(false);
        Dictionary<string, object>[] requests = { header, competing };
        bool[] admitted = new bool[2]; Exception[] admissionErrors = new Exception[2];
        Dictionary<string, object>[] receipts = new Dictionary<string, object>[2];
        Thread[] contenders = new Thread[2];
        for (int i = 0; i < contenders.Length; i++) {
          int index = i;
          contenders[i] = new Thread(delegate() {
            try {
              startGate.WaitOne();
              using (PublicationJournal contenderJournal = Begin(terminal.Root, requests[index])) {
                admitted[index] = (string)contenderJournal.last["phase"] == "PREPARED";
                receipts[index] = contenderJournal.ReclamationMetadata as Dictionary<string, object>;
              }
            } catch (Exception admissionException) { admissionErrors[index] = admissionException; }
          });
          contenders[i].IsBackground = true; contenders[i].Start();
        }
        startGate.Set();
        bool firstDone = contenders[0].Join(10000), secondDone = contenders[1].Join(10000);
        startGate.Dispose();
        if (!firstDone || !secondDone || admitted[0] == admitted[1]) throw new InvalidDataException();
        int winner = admitted[0] ? 0 : 1, loser = 1 - winner;
        string admittedId = (string)requests[winner]["transactionId"];
        admittedAfterReclaim = true; reclaimReceipt = receipts[winner];
        concurrentAdmissionSerialized = admissionErrors[loser] is InvalidOperationException &&
          admissionErrors[loser].Message == "PHI_PUBLICATION_CAPACITY_BLOCKED" && receipts[loser] == null;
        if (!concurrentAdmissionSerialized) throw new InvalidDataException();
        using (RegistryKey registry = OpenBase(false)) {
          using (RegistryKey gone = registry.OpenSubKey(terminalId, false)) terminalRemoved = gone == null;
          using (RegistryKey added = registry.OpenSubKey(admittedId, false)) if (added == null) throw new InvalidDataException();
          afterReclaim = registry.GetSubKeyNames().Length;
          otherEntriesPreserved = fullNames.Where(x => x != terminalId).All(x => registry.GetSubKeyNames().Contains(x));
        }
        Dictionary<string, object> afterTree = Snapshot(terminal.Root, terminalRootId);
        afterProjectDigest = ProjectBaseDigest(terminalRootId, (Dictionary<string, object>)afterTree["files"],
          (Dictionary<string, object>)afterTree["identities"]);
        projectUnchanged = beforeProjectDigest == afterProjectDigest;
        selectedTransactionId = reclaimReceipt == null ? null : reclaimReceipt["selectedTransactionId"] as string;
        terminalPhase = reclaimReceipt == null ? null : reclaimReceipt["terminalPhase"] as string;
        if (!terminalRemoved || !admittedAfterReclaim || !otherEntriesPreserved || !projectUnchanged || afterReclaim != MaxTransactions ||
            reclaimReceipt == null || selectedTransactionId != terminalId || terminalPhase != "CLEANED" ||
            (int)reclaimReceipt["journalVersion"] != 3 || (int)reclaimReceipt["capacityBefore"] != MaxTransactions ||
            (int)reclaimReceipt["capacityAfterReclaim"] != MaxTransactions - 1 || (int)reclaimReceipt["capacityAfterAdmission"] != MaxTransactions ||
            (string)reclaimReceipt["eligibility"] != "SAFE_TO_RECLAIM" || (bool)reclaimReceipt["filesystemVerified"] != true ||
            File.Exists(Path.Combine(terminal.Root, "input.txt")) || File.Exists(Path.Combine(terminal.Root, "new.txt")) ||
            File.ReadAllText(Path.Combine(terminal.Root, "unrelated.txt")) != "unrelated-delete-user") throw new InvalidDataException();

        stage = "RESTART_AND_IDEMPOTENCE";
        reader = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-discover", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        reader.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = terminal.Root })); reader.StandardInput.Close();
        if (!reader.WaitForExit(5000) || reader.ExitCode != 0) throw new InvalidDataException(); readerGone = reader.HasExited;
        string output = reader.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
        Dictionary<string, object> inventory = Serializer().Deserialize<Dictionary<string, object>>(output);
        IList entries = inventory["entries"] as IList;
        if ((string)inventory["status"] != "PASS_READ_ONLY_DISCOVERY" || entries == null || entries.Count != 1 ||
            (string)((Dictionary<string, object>)entries[0])["transactionId"] != admittedId) throw new InvalidDataException();
        Dictionary<string, object> secondHeader = Serializer().Deserialize<Dictionary<string, object>>(Serializer().Serialize(header));
        secondHeader["transactionId"] = Guid.NewGuid().ToString("N");
        owned.Add((string)secondHeader["transactionId"]);
        try { using (PublicationJournal rejected = Begin(terminal.Root, secondHeader)) { } }
        catch (InvalidOperationException error) { secondPassBlocked = error.Message == "PHI_PUBLICATION_CAPACITY_BLOCKED"; }
        passed = secondPassBlocked;
      } catch (Exception error) { Console.Error.WriteLine("PHI_RETENTION_CAPACITY_FAILED:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8")); }
      finally {
        if (reader != null) { try { if (!reader.HasExited) { reader.Kill(); reader.WaitForExit(3000); } } finally { reader.Dispose(); } }
        if (publisher != null) { try { if (!publisher.HasExited) { publisher.Kill(); publisher.WaitForExit(3000); } } finally { publisher.Dispose(); } }
        try {
          using (RegistryKey registry = OpenBase(true)) {
            foreach (string id in owned) if (registry.GetSubKeyNames().Contains(id)) registry.DeleteSubKeyTree(id);
            if (RegFlushKey(registry.Handle.DangerousGetHandle()) != 0 ||
                !registry.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(initialNames ?? new string[0])) throw new InvalidDataException();
          }
          if (active != null) { active.CleanupFiles(); bool gone = !Directory.Exists(active.Root); active.Complete(gone); if (!gone) throw new InvalidDataException(); }
          if (terminal != null) { terminal.CleanupFiles(); bool gone = !Directory.Exists(terminal.Root); terminal.Complete(gone); if (!gone) throw new InvalidDataException(); }
          clean = true;
        } catch { clean = false; if (active != null) active.Dispose(); if (terminal != null) terminal.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { version = 1, status = passed && clean ? "PASS" : "FAIL", scope = "NATIVE_TERMINAL_RETENTION_AT_REAL_64_ENTRY_CAPACITY",
        passed, fixtureCleanup = clean, publisherKilled = killed, publisherGone, freshReaderGone = readerGone,
        originalEntries = initialNames == null ? (object)"UNKNOWN" : initialNames.Length, filledEntries = filled,
        normal63To64, beforeReclaim, noSafeBlocked, corruptBlocked, concurrentAdmissionSerialized, oneTerminalRemoved = terminalRemoved,
        selectedTransactionId, terminalPhase, reclaimReceipt,
        otherEntriesPreserved, admittedAfterReclaim, afterReclaim, secondPassBlocked,
        projectUnchanged, beforeProjectDigest, afterProjectDigest,
        processKillsByRetention = 0, projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
    }
    static Dictionary<string, object> RetentionAdmissionHeader(string project, string transactionId) {
      string rootId = RecoveryFilesystem.DirectoryIdentity(project);
      Dictionary<string, object> snapshot = Snapshot(project, rootId);
      Dictionary<string, object> files = (Dictionary<string, object>)snapshot["files"];
      Dictionary<string, object> draft = new Dictionary<string, object>(files); draft.Add("new.txt", "new-fixture");
      bool alive; int pid = Process.GetCurrentProcess().Id;
      string generation = ScopeRecovery.ProcessCreation(pid, out alive); if (!alive) throw new InvalidDataException();
      return new Dictionary<string, object> {
        { "version", 1 }, { "transactionId", transactionId }, { "projectIdentity", rootId }, { "draftId", Guid.NewGuid().ToString("N") },
        { "draftVersion", 1 }, { "verifiedDigest", ProjectDraftDigest(draft) },
        { "baseDigest", ProjectBaseDigest(rootId, files, (Dictionary<string, object>)snapshot["identities"]) },
        { "creatorPid", pid }, { "creatorGeneration", generation },
        { "operations", new object[] { new Dictionary<string, object> { { "path", "new.txt" }, { "kind", "CREATE" },
          { "baseIdentity", null }, { "baseDigest", null }, { "newDigest", Hash(Encoding.UTF8.GetBytes("new-fixture")) }, { "newBytes", 11 } } } }
      };
    }
    internal static int RetentionAdmissionCrashChild() {
      try {
        Dictionary<string, object> request = FixtureRequest();
        string project = Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]);
        if (RecoveryFilesystem.DirectoryIdentity(project) != (string)request["rootIdentity"]) throw new InvalidDataException();
        string incoming = (string)request["transactionId"];
        using (PublicationJournal journal = Begin(project, RetentionAdmissionHeader(project, incoming), delegate() {
          // The parent kills this real process while both admission and the
          // incoming transaction leases remain held, after the old leaf and
          // parent registry flush but before any new PREPARED key exists.
          using (RegistryKey root = OpenBase(false)) using (RegistryKey absent = root.OpenSubKey(incoming, false)) {
            if (root.GetSubKeyNames().Length != MaxTransactions - 1 || absent != null) throw new InvalidDataException();
          }
          Console.WriteLine(Serializer().Serialize(new { ready = true, transactionId = incoming,
            oldKeyDurablyReclaimed = true, incomingJournalAbsent = true }));
          Console.Out.Flush(); Thread.Sleep(12000);
          throw new IOException("PHI_RETENTION_CRASH_FIXTURE_NOT_TERMINATED");
        })) { }
      } catch { Console.Error.WriteLine("PHI_RETENTION_ADMISSION_CRASH_CHILD_FAILED"); }
      return 70;
    }
    internal static int RetentionAdmissionCrashSelfTest() {
      ScopeRecovery terminal = null, filler = null; Process publisher = null, admission = null, reader = null;
      List<string> owned = new List<string>(); string[] initialNames = null;
      string terminalId = Guid.NewGuid().ToString("N"), incoming = Guid.NewGuid().ToString("N"), next = Guid.NewGuid().ToString("N");
      string stage = "BEGIN", beforeDigest = null, afterDigest = null;
      bool passed = false, clean = false, publisherGone = false, admissionKilled = false, admissionGone = false, readerGone = false;
      bool terminalRemoved = false, incomingAbsent = false, projectUnchanged = false, freshAdmission = false;
      int capacityBefore = -1, capacityAfterCrash = -1, capacityAfterFresh = -1;
      object discovery = null;
      try {
        using (RegistryKey root = OpenBase(true)) initialNames = root.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).ToArray();
        if (initialNames.Length >= MaxTransactions) throw new InvalidDataException();
        terminal = ScopeRecovery.Begin(); terminal.CreateRoot(); terminal.Ready();
        filler = ScopeRecovery.Begin(); filler.CreateRoot(); filler.Ready();
        File.WriteAllText(Path.Combine(terminal.Root, "input.txt"), "old-delete-complete", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(terminal.Root, "unrelated.txt"), "unrelated-delete-user", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(filler.Root, "input.txt"), "old-complete", new UTF8Encoding(false));
        string rootId = RecoveryFilesystem.DirectoryIdentity(terminal.Root);
        stage = "TERMINAL_PUBLISHER"; owned.Add(terminalId);
        publisher = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-delete-fixture-child cleaned", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        publisher.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = terminal.Id, rootIdentity = rootId, transactionId = terminalId }));
        publisher.StandardInput.Close();
        string ready = null; Thread waiting = new Thread(delegate() { try { ready = publisher.StandardOutput.ReadLine(); } catch { } });
        waiting.IsBackground = true; waiting.Start();
        if (!waiting.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
        Dictionary<string, object> terminalReady = Serializer().Deserialize<Dictionary<string, object>>(ready);
        if (!(bool)terminalReady["ready"] || (string)terminalReady["phase"] != "CLEANED") throw new InvalidDataException();
        publisher.Kill(); if (!publisher.WaitForExit(3000) || !publisher.HasExited || publisher.ExitCode == 0) throw new InvalidDataException();
        publisherGone = true;
        stage = "FILL_REAL_CAPACITY";
        for (int i = 0; i < MaxTransactions - initialNames.Length - 1; i++) {
          string id = Guid.NewGuid().ToString("N"); owned.Add(id);
          using (PublicationJournal entry = Begin(filler.Root, FixtureHeader(filler.Root, id))) { }
        }
        using (RegistryKey root = OpenBase(false)) capacityBefore = root.GetSubKeyNames().Length;
        if (capacityBefore != MaxTransactions) throw new InvalidDataException();
        Dictionary<string, object> snapshot = Snapshot(terminal.Root, rootId);
        beforeDigest = ProjectBaseDigest(rootId, (Dictionary<string, object>)snapshot["files"],
          (Dictionary<string, object>)snapshot["identities"]);
        stage = "CRASH_AFTER_RECLAIM"; owned.Add(incoming);
        admission = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-retention-admission-crash-child", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        admission.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = terminal.Id, rootIdentity = rootId, transactionId = incoming }));
        admission.StandardInput.Close();
        string pause = null; Thread pauseReader = new Thread(delegate() { try { pause = admission.StandardOutput.ReadLine(); } catch { } });
        pauseReader.IsBackground = true; pauseReader.Start();
        if (!pauseReader.Join(7000) || pause == null || pause.Length > 4096) throw new InvalidDataException();
        Dictionary<string, object> marker = Serializer().Deserialize<Dictionary<string, object>>(pause);
        if (!(bool)marker["ready"] || (string)marker["transactionId"] != incoming ||
            !(bool)marker["oldKeyDurablyReclaimed"] || !(bool)marker["incomingJournalAbsent"]) throw new InvalidDataException();
        admission.Kill(); admissionKilled = true;
        if (!admission.WaitForExit(3000) || !admission.HasExited || admission.ExitCode == 0) throw new InvalidDataException();
        admissionGone = true;
        stage = "FRESH_INDEX_AND_PROJECT";
        using (RegistryKey root = OpenBase(false)) using (RegistryKey old = root.OpenSubKey(terminalId, false))
        using (RegistryKey newKey = root.OpenSubKey(incoming, false)) {
          terminalRemoved = old == null; incomingAbsent = newKey == null; capacityAfterCrash = root.GetSubKeyNames().Length;
        }
        Dictionary<string, object> after = Snapshot(terminal.Root, rootId);
        afterDigest = ProjectBaseDigest(rootId, (Dictionary<string, object>)after["files"],
          (Dictionary<string, object>)after["identities"]);
        projectUnchanged = beforeDigest == afterDigest && !File.Exists(Path.Combine(terminal.Root, "new.txt"));
        if (!terminalRemoved || !incomingAbsent || capacityAfterCrash != MaxTransactions - 1 || !projectUnchanged) throw new InvalidDataException();
        reader = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-discover", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        reader.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = terminal.Root })); reader.StandardInput.Close();
        if (!reader.WaitForExit(5000) || reader.ExitCode != 0) throw new InvalidDataException(); readerGone = reader.HasExited;
        string output = reader.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
        Dictionary<string, object> observed = Serializer().Deserialize<Dictionary<string, object>>(output); discovery = observed;
        IList entries = observed["entries"] as IList;
        if ((string)observed["status"] != "PASS_READ_ONLY_DISCOVERY" || (string)observed["rootIdentity"] != rootId ||
            entries == null || entries.Count != 0 || (int)observed["scannedTransactions"] != MaxTransactions - 1 ||
            (int)observed["projectTransactions"] != 0 ||
            (bool)observed["actionPerformed"] || (int)observed["journalMutations"] != 0 ||
            (int)observed["projectMutations"] != 0 || (bool)observed["projectPublished"]) throw new InvalidDataException();
        stage = "FRESH_ADMISSION"; owned.Add(next);
        using (PublicationJournal resumed = Begin(terminal.Root, RetentionAdmissionHeader(terminal.Root, next)))
          freshAdmission = (string)resumed.last["phase"] == "PREPARED" && resumed.ReclamationMetadata == null;
        using (RegistryKey root = OpenBase(false)) capacityAfterFresh = root.GetSubKeyNames().Length;
        if (!freshAdmission || capacityAfterFresh != MaxTransactions || File.Exists(Path.Combine(terminal.Root, "new.txt"))) throw new InvalidDataException();
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_RETENTION_ADMISSION_CRASH_FAILED:" + stage + ":" +
        unchecked((uint)Marshal.GetHRForException(error)).ToString("x8")); }
      finally {
        foreach (Process process in new Process[] { reader, admission, publisher }) if (process != null) {
          try { if (!process.HasExited) { process.Kill(); process.WaitForExit(3000); } } finally { process.Dispose(); }
        }
        try {
          using (RegistryKey root = OpenBase(true)) {
            foreach (string id in owned) if (root.GetSubKeyNames().Contains(id)) root.DeleteSubKeyTree(id);
            if (RegFlushKey(root.Handle.DangerousGetHandle()) != 0 ||
                !root.GetSubKeyNames().OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(initialNames ?? new string[0])) throw new InvalidDataException();
          }
          if (filler != null) { filler.CleanupFiles(); bool removed = !Directory.Exists(filler.Root); filler.Complete(removed); if (!removed) throw new InvalidDataException(); }
          if (terminal != null) { terminal.CleanupFiles(); bool removed = !Directory.Exists(terminal.Root); terminal.Complete(removed); if (!removed) throw new InvalidDataException(); }
          clean = true;
        } catch { clean = false; if (terminal != null) terminal.Dispose(); if (filler != null) filler.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { version = 1, status = passed && clean ? "PASS" : "FAIL",
        scope = "NATIVE_RECLAIM_BEFORE_PREPARED_PROCESS_CRASH_NOT_POWER_LOSS", passed, fixtureCleanup = clean,
        publisherGone, admissionKilled, admissionGone, freshReaderGone = readerGone, terminalRemoved, incomingAbsent,
        projectUnchanged, freshAdmission, capacityBefore, capacityAfterCrash, capacityAfterFresh,
        beforeProjectDigest = beforeDigest, afterProjectDigest = afterDigest, discovery,
        projectPublished = false, externalRequests = 0 }));
      return passed && clean ? 0 : 70;
    }
    internal static int ModifyControllerRecoverySelfTest(string name) {
      string[] cases = { "rollback", "rollback-late", "manual-post-physical", "manual-commit", "cleanup-only", "unrelated-conflict", "target-conflict" };
      if (!cases.Contains(name)) return 70;
      ScopeRecovery scope = null; Process publisher = null;
      string tx = Guid.NewGuid().ToString("N"), stage = "BEGIN", phaseAtDeath = null;
      string gitDirectory = Path.Combine(Path.GetTempPath(), "phi-git-" + tx);
      bool passed = false, clean = false, gitMetadataClean = false, killed = false, childGone = false, controllerGone = false, idempotent = false;
      object evidence = null, secondEvidence = null, discoveryEvidence = null;
      string gitDiff = null, finalDigest = null; int controllerExit = -1;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root);
        string target = Path.Combine(scope.Root, "input.txt"), unrelated = Path.Combine(scope.Root, "unrelated.txt");
        File.WriteAllText(target, "old-complete", new UTF8Encoding(false));
        File.WriteAllText(unrelated, "unrelated-user", new UTF8Encoding(false));
        if (Directory.Exists(gitDirectory) || File.Exists(gitDirectory)) throw new InvalidDataException();
        FixtureGit(scope.Root, "init -q --separate-git-dir \"" + gitDirectory + "\"");
        FixtureGit(scope.Root, "add -- input.txt unrelated.txt");
        FixtureGit(scope.Root, "-c user.name=Phi -c user.email=phi@example.invalid commit -qm baseline");
        if (FixtureGit(scope.Root, "status --porcelain") != "") throw new InvalidDataException();
        Dictionary<string, object> expectedHeader = ModifyRecoveryFixtureHeader(scope.Root, tx);
        string point = name == "rollback" ? "temp" : name == "manual-post-physical" ? "before-journal-committed" :
          name == "manual-commit" ? "committed" :
          name == "cleanup-only" ? "cleanup" : "before-commit";
        stage = "START_PUBLISHER";
        publisher = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-modify-fixture-child " + point, UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true });
        publisher.StandardInput.WriteLine(Serializer().Serialize(new { scopeId = scope.Id, rootIdentity = rootId, transactionId = tx }));
        publisher.StandardInput.Close();
        string ready = null; Thread reader = new Thread(delegate() { try { ready = publisher.StandardOutput.ReadLine(); } catch { } });
        reader.IsBackground = true; reader.Start();
        if (!reader.Join(7000) || ready == null || ready.Length > 4096) throw new InvalidDataException();
        Dictionary<string, object> announcement = Serializer().Deserialize<Dictionary<string, object>>(ready);
        if (!(bool)announcement["ready"] || (string)announcement["checkpoint"] != point || (string)announcement["transactionId"] != tx) throw new InvalidDataException();
        phaseAtDeath = (string)announcement["phase"];
        stage = "KILL_PUBLISHER"; publisher.Kill(); killed = true;
        if (!publisher.WaitForExit(3000) || !publisher.HasExited || publisher.ExitCode == 0) throw new InvalidDataException(); childGone = true;
        if (name == "unrelated-conflict") File.WriteAllText(unrelated, "new-unrelated-user", new UTF8Encoding(false));
        if (name == "target-conflict") File.WriteAllText(target, "new-target-user", new UTF8Encoding(false));
        stage = "FRESH_DISCOVERY";
        using (Process discovery = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
          Arguments = "--publication-discover", UseShellExecute = false, RedirectStandardInput = true,
          RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
          try {
            discovery.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root })); discovery.StandardInput.Close();
            if (!discovery.WaitForExit(5000) || discovery.ExitCode != 0) throw new InvalidDataException();
            string output = discovery.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
            Dictionary<string, object> inventory = Serializer().Deserialize<Dictionary<string, object>>(output);
            IList entries = inventory["entries"] as IList;
            if ((string)inventory["status"] != "PASS_READ_ONLY_DISCOVERY" || (string)inventory["rootIdentity"] != rootId ||
                entries == null || entries.Count != 1 || (int)inventory["projectTransactions"] != 1 ||
                (bool)inventory["actionPerformed"] || (int)inventory["journalMutations"] != 0 ||
                (int)inventory["projectMutations"] != 0 || (bool)inventory["projectPublished"]) throw new InvalidDataException();
            Dictionary<string, object> entry = entries[0] as Dictionary<string, object>;
            if (entry == null || (string)entry["transactionId"] != tx || (int)entry["journalVersion"] != 2 ||
                (string)entry["classification"] != (name == "target-conflict" ? "CONFLICT" :
                  new string[] { "rollback", "rollback-late", "manual-post-physical", "manual-commit", "unrelated-conflict" }.Contains(name) ? "RECOVERY_REQUIRED" : "TERMINAL_RETAINED")) throw new InvalidDataException();
            discoveryEvidence = inventory;
          } finally { if (!discovery.HasExited) { discovery.Kill(); discovery.WaitForExit(3000); } }
        }
        Func<Dictionary<string, object>> recover = delegate() {
          using (Process controller = Process.Start(new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName,
            Arguments = "--publication-recover-known", UseShellExecute = false, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true })) {
            try {
              controller.StandardInput.WriteLine(Serializer().Serialize(new { version = 1, root = scope.Root, transactionId = tx,
                guardianPid = Process.GetCurrentProcess().Id, timeoutMs = 10000 })); controller.StandardInput.Close();
              if (!controller.WaitForExit(5000)) throw new InvalidDataException();
              controllerGone = controller.HasExited; controllerExit = controller.ExitCode;
              if (controllerExit != 0) throw new InvalidDataException();
              string output = controller.StandardOutput.ReadToEnd(); if (output.Length > 8192) throw new InvalidDataException();
              return Serializer().Deserialize<Dictionary<string, object>>(output);
            } finally { if (!controller.HasExited) { controller.Kill(); controller.WaitForExit(3000); } }
          }
        };
        stage = "NEW_CONTROLLER";
        Dictionary<string, object> first = recover(); evidence = first;
        string decision = name == "rollback" || name == "rollback-late" ? "ROLLBACK" :
          name == "cleanup-only" ? "CLEANUP_ONLY" : new string[] { "manual-post-physical", "manual-commit" }.Contains(name) ? "MANUAL_RECOVERY_REQUIRED" : "CONFLICT";
        string finalPhase = decision == "ROLLBACK" ? "ROLLED_BACK" : phaseAtDeath;
        if ((string)first["status"] != "PASS_BOUNDED_MODIFY_RECOVERY" || (string)first["decision"] != decision ||
            (string)first["transactionId"] != tx || (string)first["rootIdentity"] != rootId || !(bool)first["rootIdentityVerified"] ||
            (string)first["phaseBefore"] != phaseAtDeath || (string)first["phaseAfter"] != finalPhase ||
            (int)first["journalMutations"] != (decision == "ROLLBACK" ? 2 : 0) ||
            (bool)first["actionPerformed"] != (decision == "ROLLBACK") ||
            (int)first["projectMutations"] != 0 || (int)first["processKills"] != 0 ||
            (bool)first["projectPublished"] || (int)first["externalRequests"] != 0 ||
            (bool)first["baseDigestVerified"] != (decision == "ROLLBACK") ||
            (bool)first["verifiedDraftDigestMatched"] != (name == "manual-post-physical" || name == "manual-commit" || name == "cleanup-only")) throw new InvalidDataException();
        if (decision == "ROLLBACK" || decision == "CLEANUP_ONLY") {
          stage = "IDEMPOTENT_CONTROLLER";
          Dictionary<string, object> second = recover(); secondEvidence = second;
          idempotent = (string)second["decision"] == "CLEANUP_ONLY" &&
            (string)second["phaseAfter"] == finalPhase && (int)second["journalMutations"] == 0 &&
            (int)second["projectMutations"] == 0 && !(bool)second["actionPerformed"] && !(bool)second["projectPublished"];
          if (!idempotent) throw new InvalidDataException();
        }
        stage = "VERIFY_PROJECT_AND_JOURNAL";
        string actualTarget = File.ReadAllText(target), actualUnrelated = File.ReadAllText(unrelated);
        if (actualTarget != (name == "target-conflict" ? "new-target-user" :
              name == "manual-post-physical" || name == "manual-commit" || name == "cleanup-only" ? "new-complete" : "old-complete") ||
            actualUnrelated != (name == "unrelated-conflict" ? "new-unrelated-user" : "unrelated-user")) throw new InvalidDataException();
        gitDiff = FixtureGit(scope.Root, "diff --name-only");
        if (gitDiff != (name == "unrelated-conflict" ? "unrelated.txt" :
            new string[] { "manual-post-physical", "manual-commit", "cleanup-only", "target-conflict" }.Contains(name) ? "input.txt" : "")) throw new InvalidDataException();
        Dictionary<string, object> finalSnapshot = Snapshot(scope.Root, rootId);
        finalDigest = ProjectDraftDigest((Dictionary<string, object>)finalSnapshot["files"]);
        if (new string[] { "manual-post-physical", "manual-commit", "cleanup-only" }.Contains(name) && finalDigest != (string)expectedHeader["verifiedDigest"]) throw new InvalidDataException();
        using (PublicationJournal journal = new PublicationJournal(tx, scope.Root)) using (RegistryKey root = OpenBase(false))
        using (RegistryKey key = root.OpenSubKey(tx, false)) {
          if (key == null) throw new InvalidDataException(); journal.ReadChain(key);
          if ((string)journal.header["baseDigest"] != (string)expectedHeader["baseDigest"] ||
              (string)journal.header["verifiedDigest"] != (string)expectedHeader["verifiedDigest"] ||
              (string)journal.last["phase"] != finalPhase) throw new InvalidDataException();
        }
        passed = true;
      } catch (Exception error) { Console.Error.WriteLine("PHI_MODIFY_CONTROLLER_RECOVERY_FAILED:" + stage + ":" +
        unchecked((uint)Marshal.GetHRForException(error)).ToString("x8") + ":controllerExit=" + controllerExit); }
      finally {
        if (publisher != null) { try { if (!publisher.HasExited) { publisher.Kill(); publisher.WaitForExit(3000); } } finally { publisher.Dispose(); } }
        try { CleanupFixtureGit(gitDirectory, tx); gitMetadataClean = true; } catch { gitMetadataClean = false; }
        try {
          using (RegistryKey root = OpenBase(true)) if (root.GetSubKeyNames().Contains(tx)) root.DeleteSubKeyTree(tx);
          if (scope != null) { scope.CleanupFiles(); clean = !Directory.Exists(scope.Root); scope.Complete(clean); }
        } catch { clean = false; if (scope != null) scope.Dispose(); }
      }
      Console.WriteLine(Serializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean && gitMetadataClean, gitMetadataClean, actualProcessKilled = killed,
        childGone, restartedControllerGone = controllerGone, controllerExit, idempotent, journalPhaseAtInterruption = phaseAtDeath,
        discoveryEvidence, evidence, secondEvidence, gitDiff, finalDigest,
        scope = "NATIVE_BOUNDED_MODIFY_RECOVERY_NOT_RESTORED_PUBLICATION", projectPublished = false, externalRequests = 0 }));
      return passed && clean && gitMetadataClean ? 0 : 70;
    }
    internal static int ModifyFixtureChild(string phase) {
      if (!ModifyCheckpoints.Contains(phase) || phase == "before-transaction") return 70;
      try {
        Dictionary<string, object> request = FixtureRequest();
        string root = Path.Combine(ScopeRecovery.RootBase, (string)request["scopeId"]);
        Dictionary<string, object> header = ModifyRecoveryFixtureHeader(root, (string)request["transactionId"]);
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
