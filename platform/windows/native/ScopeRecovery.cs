// Durable fixed-scope ownership. Never imports arbitrary paths or kills PIDs.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Phi.Native {
  internal sealed class ScopeRecovery : IDisposable {
    internal const string RegistryBase = "Software\\Phi\\NativeScopeRecoveryV1";
    const int MaxScopes = 64;
    [StructLayout(LayoutKind.Sequential)] struct Time { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out Time created, out Time exited, out Time kernel, out Time user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll")] static extern int RegFlushKey(IntPtr key);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegQueryValueExW(IntPtr key, string name, IntPtr reserved, out uint type, byte[] data, ref uint size);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateHardLinkW(string link, string existing, IntPtr security);
    static readonly Regex IdPattern = new Regex("\\A[0-9a-f]{32}\\z", RegexOptions.CultureInvariant);
    static readonly Regex IdentityPattern = new Regex("\\A[0-9a-f]{16}:[0-9a-f]{32}\\z", RegexOptions.CultureInvariant);
    readonly Mutex lease;
    Dictionary<string, object> record;
    bool disposed;
    internal string Id { get { return (string)record["id"]; } }
    internal string Profile { get { return "Phi.Probe." + Id; } }
    internal string Root { get { return RootFor(Id); } }
    internal string FixtureRegistry { get { return "Software\\PhiProbe-" + Id; } }
    internal static string RootBase { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Phi", "NativeScopesV1"); } }
    static string RootFor(string id) { if (!IdPattern.IsMatch(id)) throw new InvalidDataException(); return Path.Combine(RootBase, id); }
    static SecurityIdentifier User { get { return WindowsIdentity.GetCurrent().User; } }
    static RegistrySecurity PrivateRegistryAcl() {
      RegistrySecurity acl = new RegistrySecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(User);
      foreach (SecurityIdentifier sid in new SecurityIdentifier[] { User, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
        acl.AddAccessRule(new RegistryAccessRule(sid, RegistryRights.FullControl, InheritanceFlags.ContainerInherit, PropagationFlags.None, AccessControlType.Allow));
      acl.AddAccessRule(new RegistryAccessRule(new SecurityIdentifier("S-1-3-4"), RegistryRights.ReadPermissions, InheritanceFlags.ContainerInherit, PropagationFlags.None, AccessControlType.Allow));
      return acl;
    }
    static void ValidateRegistry(RegistryKey key) {
      RegistrySecurity acl = key.GetAccessControl();
      if (!acl.AreAccessRulesProtected || !User.Equals(acl.GetOwner(typeof(SecurityIdentifier)))) throw new InvalidDataException();
      foreach (RegistryAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
        string sid = rule.IdentityReference.Value;
        if (rule.AccessControlType != AccessControlType.Allow || (sid != User.Value && sid != "S-1-5-18" && !(sid == "S-1-3-4" && rule.RegistryRights == RegistryRights.ReadPermissions))) throw new InvalidDataException();
      }
    }
    static RegistryKey OpenBase() {
      RegistryKey key = Registry.CurrentUser.CreateSubKey(RegistryBase, RegistryKeyPermissionCheck.ReadWriteSubTree, RegistryOptions.None, PrivateRegistryAcl());
      if (key == null) throw new InvalidDataException();
      try { ValidateRegistry(key); return key; } catch { key.Dispose(); throw; }
    }
    static void EnsureRootBase() {
      DirectorySecurity acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(User);
      foreach (SecurityIdentifier sid in new SecurityIdentifier[] { User, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
        acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-3-4"), FileSystemRights.ReadPermissions, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      Directory.CreateDirectory(RootBase, acl);
      using (RecoveryFilesystem pins = new RecoveryFilesystem(RootBase)) {
        DirectorySecurity actual = Directory.GetAccessControl(RootBase);
        if (!actual.AreAccessRulesProtected || !User.Equals(actual.GetOwner(typeof(SecurityIdentifier)))) throw new InvalidDataException();
        foreach (FileSystemAccessRule rule in actual.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
          string sid = rule.IdentityReference.Value;
          // FileSystemAccessRule automatically adds SYNCHRONIZE to Allow
          // masks. Accept only that normalization, never WRITE_DAC/WRITE_OWNER.
          if (rule.AccessControlType != AccessControlType.Allow || (sid != User.Value && sid != "S-1-5-18" && !(sid == "S-1-3-4" && (rule.FileSystemRights & ~FileSystemRights.Synchronize) == FileSystemRights.ReadPermissions))) throw new InvalidDataException();
        }
      }
    }
    static Mutex ScopeMutex(string id) {
      if (!IdPattern.IsMatch(id)) throw new InvalidDataException();
      MutexSecurity acl = new MutexSecurity(); acl.SetAccessRuleProtection(true, false);
      foreach (SecurityIdentifier sid in new SecurityIdentifier[] { User, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) }) acl.AddAccessRule(new MutexAccessRule(sid, MutexRights.FullControl, AccessControlType.Allow));
      bool created; return new Mutex(false, "Local\\Phi.Scope." + User.Value + "." + id, out created, acl);
    }
    static bool Acquire(Mutex mutex) { try { return mutex.WaitOne(0); } catch (AbandonedMutexException) { return true; } }
    static string ProcessCreation(int pid, out bool alive) {
      IntPtr process = OpenProcess(0x1000 | 0x100000, false, (uint)pid);
      if (process == IntPtr.Zero) { int error = Marshal.GetLastWin32Error(); if (error == 87) { alive = false; return null; } throw new Win32Exception(error); }
      try {
        Time created, unused1, unused2, unused3;
        if (!GetProcessTimes(process, out created, out unused1, out unused2, out unused3)) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint wait = WaitForSingleObject(process, 0); if (wait != 0 && wait != 258) throw new InvalidDataException();
        alive = wait == 258; return created.Value.ToString("x16");
      } finally { CloseHandle(process); }
    }
    ScopeRecovery() {
      string id = Guid.NewGuid().ToString("N"); lease = ScopeMutex(id);
      if (!Acquire(lease)) { lease.Dispose(); throw new InvalidDataException(); }
      try {
        bool alive; int pid = Process.GetCurrentProcess().Id;
        record = new Dictionary<string, object> { { "v", 1 }, { "id", id }, { "pid", pid }, { "created", ProcessCreation(pid, out alive) }, { "profile", false }, { "registry", false }, { "rootIdentity", "" }, { "ready", false } };
        using (RegistryKey root = OpenBase()) {
          using (RegistryKey existing = root.OpenSubKey(id))
            if (root.GetSubKeyNames().Length >= MaxScopes || existing != null) throw new InvalidDataException();
          using (RegistryKey key = root.CreateSubKey(id, RegistryKeyPermissionCheck.ReadWriteSubTree, RegistryOptions.None, PrivateRegistryAcl())) Write(key, record);
        }
      } catch { Dispose(); throw; }
    }
    internal static ScopeRecovery Begin() {
      string phase = "ROOT_BASE";
      try {
        EnsureRootBase(); phase = "PASS";
        int code = Recover(false, null); if (code != 0) throw new InvalidOperationException("PHI_RECOVERY_UNSAFE_STATE");
        phase = "RECEIPT"; return new ScopeRecovery();
      } catch { Console.Error.WriteLine("PHI_RECOVERY_BEGIN_" + phase + "_FAILED"); throw; }
    }
    static void Write(RegistryKey key, Dictionary<string, object> value) {
      ValidateRegistry(key);
      key.SetValue("Receipt", new JavaScriptSerializer().Serialize(value), RegistryValueKind.String);
      if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
    }
    void Save() { using (RegistryKey root = OpenBase()) using (RegistryKey key = root.OpenSubKey(Id, true)) { if (key == null) throw new InvalidDataException(); Write(key, record); } }
    internal void ProfileCreated() { record["profile"] = true; Save(); }
    internal void ProfileRemoved() { record["profile"] = false; Save(); }
    internal void RootCreated() { record["rootIdentity"] = RecoveryFilesystem.DirectoryIdentity(Root); Save(); }
    internal void CleanupFiles() { using (RecoveryFilesystem pins = new RecoveryFilesystem(RootBase)) pins.DeleteOwnedTree(Root, (string)record["rootIdentity"]); }
    internal void RegistryCreated() { record["registry"] = true; Save(); }
    internal void Ready() { record["ready"] = true; Save(); }
    internal void Complete(bool clean) {
      if (clean) using (RegistryKey root = OpenBase()) { root.DeleteSubKeyTree(Id); if (RegFlushKey(root.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException(); }
      Dispose();
    }
    static Dictionary<string, object> Read(RegistryKey key, string id) {
      ValidateRegistry(key);
      uint type, size = 0;
      if (RegQueryValueExW(key.Handle.DangerousGetHandle(), "Receipt", IntPtr.Zero, out type, null, ref size) != 0 || type != 1 || size < 2 || size > 4096) throw new InvalidDataException();
      byte[] bytes = new byte[size];
      if (RegQueryValueExW(key.Handle.DangerousGetHandle(), "Receipt", IntPtr.Zero, out type, bytes, ref size) != 0 || type != 1 || size > bytes.Length || (size & 1) != 0) throw new InvalidDataException();
      Dictionary<string, object> value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.Unicode.GetString(bytes, 0, (int)size).TrimEnd('\0'));
      string[] keys = { "v", "id", "pid", "created", "profile", "registry", "rootIdentity", "ready" };
      if (value == null || value.Count != keys.Length || keys.Any(k => !value.ContainsKey(k)) || !(value["v"] is int) || (int)value["v"] != 1 || (string)value["id"] != id || !(value["pid"] is int) || (int)value["pid"] < 1 || !(value["created"] is string) || !Regex.IsMatch((string)value["created"], "\\A[0-9a-f]{16}\\z") || !(value["profile"] is bool) || !(value["registry"] is bool) || !(value["ready"] is bool) || !(value["rootIdentity"] is string) || (!IdentityPattern.IsMatch((string)value["rootIdentity"]) && (string)value["rootIdentity"] != "")) throw new InvalidDataException();
      return value;
    }
    internal static int Recover(bool emit, string only) {
      int scanned = 0, active = 0, recovered = 0, quarantined = 0;
      DateTime deadline = DateTime.UtcNow.AddSeconds(10);
      string phase = "ROOT_BASE";
      try {
        EnsureRootBase();
        phase = "REGISTRY_BASE";
        using (RegistryKey root = OpenBase()) {
          string[] ids = only == null ? root.GetSubKeyNames() : new string[] { only };
          if (ids.Length > MaxScopes) throw new InvalidDataException();
          foreach (string id in ids.OrderBy(x => x, StringComparer.Ordinal)) {
            if (DateTime.UtcNow >= deadline) throw new InvalidDataException();
            scanned++;
            if (!IdPattern.IsMatch(id)) { quarantined++; continue; }
            using (Mutex mutex = ScopeMutex(id)) {
              if (!Acquire(mutex)) { active++; continue; }
              try {
                phase = "RECEIPT";
                Dictionary<string, object> value;
                using (RegistryKey key = root.OpenSubKey(id)) { if (key == null) continue; value = Read(key, id); }
                bool live; string generation = ProcessCreation((int)value["pid"], out live);
                // A reused PID is NOT authority to kill that unrelated process.
                if (live && generation == (string)value["created"]) { active++; continue; }
                string directory = RootFor(id), identity = (string)value["rootIdentity"];
                // A failed filesystem identity check must not prevent cleanup
                // of separately proven profile/registry ownership. Preserve
                // the quarantined receipt and never delete the unknown tree.
                bool failed = false;
                phase = "FILES";
                try {
                  using (RecoveryFilesystem pins = new RecoveryFilesystem(RootBase)) {
                    if (identity == "") { if (Directory.Exists(directory) || (!(bool)value["profile"] && !(bool)value["registry"] && !(bool)value["ready"])) throw new InvalidDataException(); }
                    else pins.DeleteOwnedTree(directory, identity);
                  }
                } catch { failed = true; Console.Error.WriteLine("PHI_RECOVERY_FILES_FAILED"); }
                phase = "REGISTRY";
                try {
                  if ((bool)value["registry"]) {
                    string fixture = "Software\\PhiProbe-" + id;
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(fixture)) if (key != null) { if (!User.Equals(key.GetAccessControl().GetOwner(typeof(SecurityIdentifier)))) throw new InvalidDataException(); }
                    Registry.CurrentUser.DeleteSubKeyTree(fixture, false);
                    value["registry"] = false;
                    using (RegistryKey key = root.OpenSubKey(id, true)) Write(key, value);
                  }
                } catch { failed = true; Console.Error.WriteLine("PHI_RECOVERY_REGISTRY_FAILED"); }
                phase = "PROFILE";
                try {
                  if ((bool)value["profile"]) {
                    int result = DeleteAppContainerProfile("Phi.Probe." + id);
                    if (result != 0 && result != unchecked((int)0x80070002) && result != unchecked((int)0x80070003)) throw new InvalidDataException();
                    value["profile"] = false;
                    using (RegistryKey key = root.OpenSubKey(id, true)) Write(key, value);
                  }
                } catch { failed = true; Console.Error.WriteLine("PHI_RECOVERY_PROFILE_FAILED"); }
                if (failed) { quarantined++; continue; }
                phase = "COMMIT";
                root.DeleteSubKeyTree(id); if (RegFlushKey(root.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException(); recovered++;
              } catch { quarantined++; Console.Error.WriteLine("PHI_RECOVERY_" + phase + "_FAILED"); }
              finally { mutex.ReleaseMutex(); }
            }
          }
        }
      } catch { quarantined++; Console.Error.WriteLine("PHI_RECOVERY_" + phase + "_FAILED"); }
      if (emit) Console.WriteLine(new JavaScriptSerializer().Serialize(new { scope = "FIXED_NATIVE_SCOPES_ONLY", scanned, active, recovered, quarantined, processKills = 0, status = quarantined == 0 ? "PASS" : "FAIL" }));
      return quarantined == 0 ? 0 : 70;
    }
    public void Dispose() { if (disposed) return; disposed = true; lease.ReleaseMutex(); lease.Dispose(); }
    // Fixed owned fixtures only: never a generic metadata import/edit API.
    internal static int SelfTest(string name) {
      string[] cases = { "clean", "pid-reuse", "corrupt", "unknown-field", "oversized", "missing", "root-swap", "hardlink", "junction", "root-swap-security", "partially-missing-security" };
      if (!cases.Contains(name)) return 70;
      ScopeRecovery scope = null;
      Dictionary<string, object> saved = null;
      string extra = null, extraIdentity = null, replacementIdentity = null;
      bool passed = false, fixtureClean = true, profileOwned = false, registryOwned = false;
      try {
        scope = Begin();
        if (name == "clean") {
          string id = scope.Id; scope.Complete(true);
          passed = Recover(false, id) == 0;
        } else {
          Directory.CreateDirectory(scope.Root);
          File.WriteAllText(Path.Combine(scope.Root, "sentinel.txt"), "synthetic-scope-owned");
          scope.RootCreated(); scope.Ready();
          if (name == "root-swap-security" || name == "partially-missing-security") {
            IntPtr profileSid;
            int created = CreateAppContainerProfile(scope.Profile, "Phi recovery fixture", "Synthetic recovery fixture only", IntPtr.Zero, 0, out profileSid);
            if (created != 0 || profileSid == IntPtr.Zero) throw new InvalidDataException();
            profileOwned = true; FreeSid(profileSid); scope.ProfileCreated();
            using (RegistryKey existing = Registry.CurrentUser.OpenSubKey(scope.FixtureRegistry)) if (existing != null) throw new InvalidDataException();
            using (RegistryKey fixture = Registry.CurrentUser.CreateSubKey(scope.FixtureRegistry, RegistryKeyPermissionCheck.ReadWriteSubTree, RegistryOptions.None, PrivateRegistryAcl())) fixture.SetValue("Fixture", "synthetic-owned");
            registryOwned = true; scope.RegistryCreated();
            if (name == "partially-missing-security") {
              if (DeleteAppContainerProfile(scope.Profile) != 0) throw new InvalidDataException();
              Registry.CurrentUser.DeleteSubKeyTree(scope.FixtureRegistry);
            }
          }
          // A live unrelated generation with the recorded PID must not be
          // killed. The record deliberately refers to a different generation.
          scope.record["created"] = "0000000000000001"; scope.Save();
          saved = new Dictionary<string, object>(scope.record);
          if (name == "corrupt" || name == "unknown-field" || name == "oversized") {
            using (RegistryKey root = OpenBase()) using (RegistryKey key = root.OpenSubKey(scope.Id, true)) {
              string text = name == "corrupt" ? "invalid-receipt" : name == "oversized" ? new string('x', 5000) : new JavaScriptSerializer().Serialize(new Dictionary<string, object>(saved) { { "unrecognized", "synthetic-not-echoed" } });
              key.SetValue("Receipt", text, RegistryValueKind.String); if (RegFlushKey(key.Handle.DangerousGetHandle()) != 0) throw new InvalidDataException();
            }
          }
          if (name == "missing") scope.CleanupFiles();
          if (name == "root-swap" || name == "root-swap-security" || name == "hardlink" || name == "junction") {
            extra = RootFor(Guid.NewGuid().ToString("N"));
            if (name == "root-swap" || name == "root-swap-security") {
              Directory.Move(scope.Root, extra); extraIdentity = RecoveryFilesystem.DirectoryIdentity(extra);
              Directory.CreateDirectory(scope.Root);
              File.WriteAllText(Path.Combine(scope.Root, "sentinel.txt"), "synthetic-replacement-not-owned-by-receipt");
              replacementIdentity = RecoveryFilesystem.DirectoryIdentity(scope.Root);
            } else {
              Directory.CreateDirectory(extra); extraIdentity = RecoveryFilesystem.DirectoryIdentity(extra);
              File.WriteAllText(Path.Combine(extra, "sentinel.txt"), "synthetic-unrelated-original");
              if (name == "hardlink" && !CreateHardLinkW(Path.Combine(scope.Root, "link"), Path.Combine(extra, "sentinel.txt"), IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
              if (name == "junction") AppContainerScope.CreateOwnedJunction(Path.Combine(scope.Root, "link"), extra);
            }
          }
          scope.Dispose();
          int result = Recover(false, scope.Id);
          if (name == "corrupt" || name == "unknown-field" || name == "oversized" || name == "root-swap" || name == "root-swap-security") {
            if (result != 70 || !Directory.Exists(scope.Root)) throw new InvalidDataException();
            string expected = name == "root-swap" || name == "root-swap-security" ? "synthetic-replacement-not-owned-by-receipt" : "synthetic-scope-owned";
            if (File.ReadAllText(Path.Combine(scope.Root, "sentinel.txt")) != expected) throw new InvalidDataException();
            if (name == "root-swap" || name == "root-swap-security") {
              if (name == "root-swap-security") {
                using (RegistryKey root = OpenBase()) using (RegistryKey key = root.OpenSubKey(scope.Id)) {
                  Dictionary<string, object> remaining = Read(key, scope.Id);
                  if ((bool)remaining["profile"] || (bool)remaining["registry"]) throw new InvalidDataException();
                  saved = remaining;
                }
                using (RegistryKey fixture = Registry.CurrentUser.OpenSubKey(scope.FixtureRegistry)) if (fixture != null) throw new InvalidDataException();
                // Creating the exact same name must succeed: a live residual
                // profile would return ALREADY_EXISTS. No SID derivation guess.
                IntPtr recreatedSid;
                if (CreateAppContainerProfile(scope.Profile, "Phi recovery control", "Synthetic absence control", IntPtr.Zero, 0, out recreatedSid) != 0 || recreatedSid == IntPtr.Zero) throw new InvalidDataException();
                FreeSid(recreatedSid);
                if (DeleteAppContainerProfile(scope.Profile) != 0) throw new InvalidDataException();
              }
              using (RecoveryFilesystem pins = new RecoveryFilesystem(RootBase)) pins.DeleteOwnedTree(scope.Root, replacementIdentity);
              replacementIdentity = null;
              Directory.Move(extra, scope.Root); extra = null;
            }
            using (RegistryKey root = OpenBase()) using (RegistryKey key = root.OpenSubKey(scope.Id, true)) Write(key, saved);
            result = Recover(false, scope.Id);
          }
          if (result != 0 || Directory.Exists(scope.Root) || Recover(false, scope.Id) != 0) throw new InvalidDataException();
          if (extra != null && File.ReadAllText(Path.Combine(extra, "sentinel.txt")) != "synthetic-unrelated-original") throw new InvalidDataException();
          bool alive; if (ProcessCreation(Process.GetCurrentProcess().Id, out alive) == null || !alive) throw new InvalidDataException();
          passed = true;
        }
      } catch { Console.Error.WriteLine("PHI_RECOVERY_SELFTEST_FAILED"); }
      finally {
        // Only exact fresh self-test objects with their captured identities.
        // Never clean an arbitrary path from corrupt metadata.
        try {
          if (scope != null) {
            scope.Dispose();
            if (profileOwned) {
              int deleted = DeleteAppContainerProfile(scope.Profile);
              if (deleted != 0 && deleted != unchecked((int)0x80070002) && deleted != unchecked((int)0x80070003)) throw new InvalidDataException();
            }
            if (registryOwned) Registry.CurrentUser.DeleteSubKeyTree(scope.FixtureRegistry, false);
            if (saved != null && Directory.Exists(scope.Root)) {
              string expected = replacementIdentity ?? (string)saved["rootIdentity"];
              using (RecoveryFilesystem pins = new RecoveryFilesystem(RootBase)) pins.DeleteOwnedTree(scope.Root, expected);
            }
            using (RegistryKey root = OpenBase()) root.DeleteSubKeyTree(scope.Id, false);
          }
          if (extra != null) using (RecoveryFilesystem pins = new RecoveryFilesystem(RootBase)) pins.DeleteOwnedTree(extra, extraIdentity);
        } catch { fixtureClean = false; Console.Error.WriteLine("PHI_RECOVERY_SELFTEST_CLEANUP_FAILED"); }
      }
      Console.WriteLine(new JavaScriptSerializer().Serialize(new { caseName = name, passed, fixtureCleanup = fixtureClean, processKills = 0 }));
      return passed && fixtureClean ? 0 : 70;
    }
  }
}
