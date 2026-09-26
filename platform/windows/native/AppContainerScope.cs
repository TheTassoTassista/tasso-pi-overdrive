// Experimental confinement primitive. NOT registered as an agent tool/backend.
// The sole callable operation is a fixed synthetic probe on owned fresh data.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace Phi.Native {
  internal sealed class AppContainerScope : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Capabilities {
      public IntPtr Sid, Entries; public uint Count, Reserved;
    }
    [StructLayout(LayoutKind.Sequential)] struct CapabilityEntry { public IntPtr Sid; public uint Attributes; }
    [DllImport("kernelbase.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr entries, out uint entryCount);
    [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int type, out uint value, uint size, out uint returned);
    [DllImport("advapi32.dll", SetLastError=true, EntryPoint="GetTokenInformation")] static extern bool TokenBuffer(IntPtr token, int type, IntPtr buffer, uint size, out uint returned);
    [DllImport("advapi32.dll")] static extern bool EqualSid(IntPtr first, IntPtr second);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetThreadToken(IntPtr thread, IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern int RegOpenKeyExW(IntPtr root, string subkey, uint options, uint access, out IntPtr key);
    [DllImport("advapi32.dll")] static extern int RegCloseKey(IntPtr key);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr file, byte[] buffer, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateHardLinkW(string link, string existing, IntPtr security);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(IntPtr file, uint code, byte[] input, uint inputSize, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool RemoveDirectoryW(string directory);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle, uint type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    readonly string profile;
    readonly ScopeRecovery recovery;
    readonly IntPtr sid;
    IntPtr capabilities, policy, registrySid, registryEntry;
    bool registered;
    bool disposed;
    bool optOut = true;
    internal int AttributeCount { get { return optOut ? 4 : 3; } }
    internal bool TokenVerified { get; private set; }
    string privateRegistry;
    string protectedDirectory, readOnlyAsset;
    uint guardianPid;
    internal AppContainerScope() {
      recovery = ScopeRecovery.Begin();
      profile = recovery.Profile;
      try {
        // Minimal OS registry-read capability is needed by Node's Winsock
        // initialization. No network/file/identity/service capabilities added.
        registrySid = RegistryReadSid();
        CapabilityEntry entry = new CapabilityEntry(); entry.Sid = registrySid; entry.Attributes = 4;
        registryEntry = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CapabilityEntry))); Marshal.StructureToPtr(entry, registryEntry, false);
        int result = CreateAppContainerProfile(profile, "Phi isolated probe", "Synthetic confinement validation only", registryEntry, 1, out sid);
        if (result != 0 || sid == IntPtr.Zero) throw new InvalidOperationException("PHI_APPCONTAINER_PROFILE_FAILED");
        registered = true;
        recovery.ProfileCreated();
        Capabilities value = new Capabilities(); value.Sid = sid; value.Entries = registryEntry; value.Count = 1;
        capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Capabilities)));
        Marshal.StructureToPtr(value, capabilities, false);
        policy = Marshal.AllocHGlobal(4); Marshal.WriteInt32(policy, 1); // ALL_APPLICATION_PACKAGES opt-out / LPAC
      } catch {
        bool clean = false;
        try { Dispose(); clean = true; } finally { recovery.Complete(clean); }
        throw;
      }
    }
    static IntPtr RegistryReadSid() {
      IntPtr groups = IntPtr.Zero, entries = IntPtr.Zero, result = IntPtr.Zero; uint groupCount = 0, entryCount = 0;
      try {
        if (!DeriveCapabilitySidsFromName("registryRead", out groups, out groupCount, out entries, out entryCount) || groupCount > 16 || entryCount != 1) throw new InvalidDataException();
        IntPtr entry = Marshal.ReadIntPtr(entries); uint size = GetLengthSid(entry);
        if (size < 8 || size > 128) throw new InvalidDataException();
        byte[] bytes = new byte[size]; Marshal.Copy(entry, bytes, 0, (int)size);
        result = Marshal.AllocHGlobal((int)size); Marshal.Copy(bytes, 0, result, (int)size); return result;
      } finally {
        foreach (Tuple<IntPtr, uint> array in new Tuple<IntPtr, uint>[] { Tuple.Create(groups, groupCount), Tuple.Create(entries, entryCount) }) {
          if (array.Item1 != IntPtr.Zero) { for (uint index = 0; index < Math.Min(array.Item2, 16); index++) LocalFree(Marshal.ReadIntPtr(array.Item1, (int)index * IntPtr.Size)); LocalFree(array.Item1); }
        }
      }
    }
    internal void ApplyAttributes(IntPtr list) {
      TokenVerified = false;
      if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x20009), capabilities, new IntPtr(Marshal.SizeOf(typeof(Capabilities))), IntPtr.Zero, IntPtr.Zero) ||
          (optOut && !UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000f), policy, new IntPtr(4), IntPtr.Zero, IntPtr.Zero))) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    internal void VerifyToken(IntPtr process) {
      IntPtr token; if (!OpenProcessToken(process, 10, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        uint value, returned;
        if (!GetTokenInformation(token, 29, out value, 4, out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (returned != 4 || value != 1) { Console.Error.WriteLine("PHI_APPCONTAINER_TOKEN_REJECTED:APP:" + value + ":" + returned); throw new InvalidDataException(); }
        // Class 46 is rejected with ERROR_INVALID_PARAMETER by actual user-mode
        // Windows. Do not fabricate that flag: query documented SID/capabilities,
        // and prove ALL_APPLICATION_PACKAGES opt-out using an access canary below.
        IntPtr buffer = Marshal.AllocHGlobal(256);
        try {
          if (!TokenBuffer(token, 30, buffer, 256, out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
          if (returned < 24 || returned > 256 || Marshal.ReadInt32(buffer) != 1 || !EqualSid(Marshal.ReadIntPtr(buffer, 8), registrySid) || Marshal.ReadInt32(buffer, 16) != 4) { Console.Error.WriteLine("PHI_APPCONTAINER_TOKEN_REJECTED:CAPABILITIES:" + returned + ":" + Marshal.ReadInt32(buffer)); throw new InvalidDataException(); }
          if (!TokenBuffer(token, 31, buffer, 256, out returned)) throw new Win32Exception(Marshal.GetLastWin32Error());
          // The variable-size buffer includes the pointed-to SID, not just the
          // TOKEN_APPCONTAINER_INFORMATION pointer-sized header.
          if (returned < IntPtr.Size || returned > 256 || !EqualSid(Marshal.ReadIntPtr(buffer), sid)) { Console.Error.WriteLine("PHI_APPCONTAINER_TOKEN_REJECTED:SID:" + returned); throw new InvalidDataException(); }
        } finally { Marshal.FreeHGlobal(buffer); }
        if (optOut) VerifyRegistryAndHostProcess(token);
        TokenVerified = true;
      } finally { CloseHandle(token); }
    }
    void VerifyRegistryAndHostProcess(IntPtr token) {
      IntPtr duplicate = IntPtr.Zero, publicKey = IntPtr.Zero, privateKey = IntPtr.Zero, journalKey = IntPtr.Zero, hostProcess = IntPtr.Zero;
      bool impersonating = false;
      try {
        if (!DuplicateToken(token, 2, out duplicate) || !SetThreadToken(IntPtr.Zero, duplicate)) throw new Win32Exception(Marshal.GetLastWin32Error());
        impersonating = true;
        // Direct, documented registry APIs using the real child's effective
        // token. No reg.exe/shell subprocess or virtualized HKCU false negative.
        int publicResult = RegOpenKeyExW(new IntPtr(unchecked((int)0x80000002)), "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0, 0x20019 | 0x100, out publicKey);
        int privateResult = RegOpenKeyExW(new IntPtr(unchecked((int)0x80000003)), privateRegistry, 0, 0x20019 | 0x100, out privateKey);
        int journalResult = RegOpenKeyExW(new IntPtr(unchecked((int)0x80000003)), WindowsIdentity.GetCurrent().User.Value + "\\" + ScopeRecovery.RegistryBase + "\\" + recovery.Id, 0, 0x20019 | 0x100, out journalKey);
        hostProcess = OpenProcess(0x40, false, guardianPid); // PROCESS_DUP_HANDLE, not a destructive operation
        int processError = Marshal.GetLastWin32Error();
        bool registryRead = publicResult == 0, privateDenied = privateResult == 5, hostHandleDenied = hostProcess == IntPtr.Zero && processError == 5;
        bool protectedDaclDenied = WriteDaclDenied(protectedDirectory, true), runtimeDaclDenied = WriteDaclDenied(readOnlyAsset, false);
        if (!registryRead || !privateDenied || journalResult != 5 || !hostHandleDenied || !protectedDaclDenied || !runtimeDaclDenied) throw new InvalidDataException();
      } finally {
        if (publicKey != IntPtr.Zero) RegCloseKey(publicKey);
        if (privateKey != IntPtr.Zero) RegCloseKey(privateKey);
        if (journalKey != IntPtr.Zero) RegCloseKey(journalKey);
        if (hostProcess != IntPtr.Zero) CloseHandle(hostProcess);
        if (impersonating && !RevertToSelf()) Environment.FailFast("PHI_APPCONTAINER_REVERT_FAILED");
        if (duplicate != IntPtr.Zero) CloseHandle(duplicate);
      }
      Console.WriteLine("{\"registryReadAvailable\":true,\"privateRegistryDenied\":true,\"journalRegistryDenied\":true,\"hostHandleDuplicationDenied\":true,\"protectedDaclChangeDenied\":true,\"runtimeDaclChangeDenied\":true}");
    }
    static bool WriteDaclDenied(string file, bool directory) {
      // Opening WRITE_DAC is enough to test the owner-rights escape without
      // changing any ACL, including when the negative assertion fails.
      IntPtr handle = CreateFileW(file, 0x40000, 7, IntPtr.Zero, 3, 0x200000 | (directory ? 0x2000000U : 0U), IntPtr.Zero);
      int error = Marshal.GetLastWin32Error();
      if (handle != new IntPtr(-1)) { CloseHandle(handle); return false; }
      return error == 5;
    }
    static void WriteAlternateStream(string ownedFile) {
      // .NET Framework path validation rejects ADS syntax before the OS sees
      // it. Use native handles only for this fixed fresh owned fixture, and
      // read back its exact bytes so a missing stream cannot pass the denial.
      byte[] bytes = Encoding.UTF8.GetBytes("SYNTHETIC_PRIVATE_STREAM_ONLY");
      IntPtr handle = CreateFileW(ownedFile + ":fixture", 0xc0000000, 0, IntPtr.Zero, 1, 0, IntPtr.Zero);
      if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        uint written;
        if (!WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero) || written != bytes.Length) throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { CloseHandle(handle); }
      handle = CreateFileW(ownedFile + ":fixture", 0x80000000, 1, IntPtr.Zero, 3, 0, IntPtr.Zero);
      if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        uint read; byte[] actual = new byte[bytes.Length + 1];
        if (!ReadFile(handle, actual, (uint)actual.Length, out read, IntPtr.Zero) || read != bytes.Length) throw new InvalidDataException();
        for (int index = 0; index < bytes.Length; index++) if (bytes[index] != actual[index]) throw new InvalidDataException();
      } finally { CloseHandle(handle); }
    }
    internal static void CreateOwnedJunction(string directory, string target) {
      // Controller-only, fixed synthetic paths under the same fresh root.
      // Real NTFS mount-point reparse data, not a shell command or a mock.
      Directory.CreateDirectory(directory);
      byte[] substitute = Encoding.Unicode.GetBytes("\\??\\" + target);
      byte[] display = Encoding.Unicode.GetBytes(target);
      int payload = 8 + substitute.Length + 2 + display.Length + 2;
      if (payload > 16376) throw new InvalidDataException();
      byte[] buffer = new byte[8 + payload];
      using (BinaryWriter writer = new BinaryWriter(new MemoryStream(buffer))) {
        writer.Write(0xa0000003U); writer.Write((ushort)payload); writer.Write((ushort)0);
        writer.Write((ushort)0); writer.Write((ushort)substitute.Length);
        writer.Write((ushort)(substitute.Length + 2)); writer.Write((ushort)display.Length);
        writer.Write(substitute); writer.Write((ushort)0); writer.Write(display); writer.Write((ushort)0);
      }
      IntPtr handle = CreateFileW(directory, 0x40000000, 7, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero);
      if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        uint returned;
        if (!DeviceIoControl(handle, 0x900a4, buffer, (uint)buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally { CloseHandle(handle); }
      if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0) throw new InvalidDataException();
    }
    int RunAllPackagesControl(Dictionary<string, object> request, string runtime, string file) {
      // Fixed, read-only positive control only. Never expose this mode in a
      // request schema or route arbitrary code through ordinary AppContainer.
      Dictionary<string, object> control = new Dictionary<string, object>(request);
      control["cwd"] = runtime;
      control["args"] = new string[] { "--no-addons", "-e", "let ok=false;try{ok=require('node:fs').readFileSync(process.argv[1],'utf8')==='synthetic-all-packages';}catch{}console.log(JSON.stringify({allPackagesReadControl:ok}));process.exit(ok?0:1);", file };
      optOut = false;
      try {
        using (MemoryStream input = new MemoryStream(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(control) + "\n"))) return OwnedProcess.Execute(input, this);
      } finally { optOut = true; TokenVerified = false; }
    }
    static void LowLabel(IntPtr directory) {
      IntPtr descriptor = IntPtr.Zero;
      try {
        uint size; bool present, defaulted; IntPtr sacl;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;OICI;NW;;;LW)", 1, out descriptor, out size) ||
            !GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted) || !present) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (sacl == IntPtr.Zero) throw new InvalidDataException();
        uint result = SetSecurityInfo(directory, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
        if (result != 0) throw new Win32Exception((int)result);
      } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    internal void SetDirectoryAuthority(string directory, bool readable, bool writable) {
      // ONLY fresh controller-owned synthetic directories. No recursive host ACL
      // mutation. No generic caller-supplied path or role overrides are exposed.
      string full = Path.GetFullPath(directory), allowed = Path.GetFullPath(recovery.Root);
      if (!full.Equals(allowed, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(allowed + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
      string identityBefore = RecoveryFilesystem.DirectoryIdentity(full);
      DirectorySecurity acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
      InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
      SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
      foreach (SecurityIdentifier identity in new SecurityIdentifier[] { user, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
        acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
      // Suppress implicit owner WRITE_DAC in the restricted token.
      acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-3-4"), FileSystemRights.ReadPermissions, inherit, PropagationFlags.None, AccessControlType.Allow));
      if (readable) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), writable ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
      byte[] bytes = acl.GetSecurityDescriptorBinaryForm();
      RecoveryFilesystem.WithDirectoryAuthority(full, identityBefore, delegate(IntPtr handle) {
        IntPtr descriptor = Marshal.AllocHGlobal(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, descriptor, bytes.Length);
          bool present, defaulted; IntPtr dacl;
          if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero) throw new InvalidDataException();
          uint result = SetSecurityInfo(handle, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
          if (result != 0) Console.Error.WriteLine("PHI_ACL_DACL_FAILED");
          if (result != 0) throw new Win32Exception((int)result);
          if (writable) {
            try { LowLabel(handle); } catch { Console.Error.WriteLine("PHI_ACL_LABEL_FAILED"); throw; }
          }
        } finally { Marshal.FreeHGlobal(descriptor); }
      });
    }
    public void Dispose() {
      if (disposed) return; disposed = true;
      int result = registered ? DeleteAppContainerProfile(profile) : 0;
      if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
      if (policy != IntPtr.Zero) Marshal.FreeHGlobal(policy);
      if (registryEntry != IntPtr.Zero) Marshal.FreeHGlobal(registryEntry);
      if (registrySid != IntPtr.Zero) Marshal.FreeHGlobal(registrySid);
      if (sid != IntPtr.Zero) FreeSid(sid);
      if (result != 0) { Console.Error.WriteLine("PHI_APPCONTAINER_PROFILE_CLEANUP_FAILED:" + result); throw new InvalidOperationException("PHI_APPCONTAINER_CLEANUP_FAILED"); }
      recovery.ProfileRemoved();
    }
    internal static int Probe(string node, string role, string portText, string failure = "normal") {
      if (failure != "normal" && failure != "hold-child" && failure != "hold-tree" && failure != "timeout-tree" && failure != "before-cleanup" && failure != "cleanup-exception") return 70;
      if (IntPtr.Size != 8 || (role != "worker" && role != "tester" && role != "reviewer")) return 70;
      int port;
      if (!Int32.TryParse(portText, out port) || port < 1 || port > 65535 || !Path.IsPathRooted(node) || node.StartsWith("\\\\") || !node.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return 70;
      string root = null, registryKey = null, ownedJunction = null; AppContainerScope scope = null; int code = 70; bool cleaned = false, aliasesReady = false;
      try {
        if ((File.GetAttributes(node) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        scope = new AppContainerScope();
        root = scope.recovery.Root;
        scope.recovery.CreateRoot(); scope.SetDirectoryAuthority(root, true, false);
        string runtime = Path.Combine(root, "runtime"), workspace = Path.Combine(root, "workspace"), scratch = Path.Combine(root, "scratch"), secret = Path.Combine(root, "host-private");
        foreach (string directory in new string[] { runtime, workspace, scratch, secret }) Directory.CreateDirectory(directory);
        scope.SetDirectoryAuthority(runtime, true, false); scope.SetDirectoryAuthority(workspace, true, role == "worker");
        scope.SetDirectoryAuthority(scratch, true, true); scope.SetDirectoryAuthority(secret, false, false);
        string executable = Path.Combine(runtime, "node.exe"); File.Copy(node, executable, false);
        // Copying a read-only runtime asset must not make owned cleanup fail.
        // This changes attributes only on this fresh owned copy; never source.
        File.SetAttributes(executable, FileAttributes.Normal);
        File.WriteAllText(Path.Combine(workspace, "fixture.txt"), "synthetic-input");
        File.WriteAllText(Path.Combine(secret, ".env"), "SYNTHETIC_PRIVATE_PROBE_ONLY");
        WriteAlternateStream(Path.Combine(secret, ".env"));
        scope.protectedDirectory = secret;
        scope.readOnlyAsset = Path.Combine(runtime, "read-only.txt"); File.WriteAllText(scope.readOnlyAsset, "synthetic-read-only");
        string junction = Path.Combine(scratch, "host-junction"), privateLink = Path.Combine(scratch, "host-private-link"), assetLink = Path.Combine(scratch, "host-read-only-link");
        ownedJunction = junction;
        CreateOwnedJunction(junction, secret);
        if (!CreateHardLinkW(privateLink, Path.Combine(secret, ".env"), IntPtr.Zero) || !CreateHardLinkW(assetLink, scope.readOnlyAsset, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        // Host positive controls prove actual pre-existing alias traversal.
        // Child-side creation denial alone is not enough for this assertion.
        if (File.ReadAllText(Path.Combine(junction, ".env")) != "SYNTHETIC_PRIVATE_PROBE_ONLY" || File.ReadAllText(privateLink) != "SYNTHETIC_PRIVATE_PROBE_ONLY" || File.ReadAllText(assetLink) != "synthetic-read-only") throw new InvalidDataException();
        aliasesReady = true;
        string allPackages = Path.Combine(runtime, "all-packages.txt"); File.WriteAllText(allPackages, "synthetic-all-packages");
        FileSecurity allAcl = new FileSecurity(); allAcl.SetAccessRuleProtection(true, false);
        allAcl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, AccessControlType.Allow));
        allAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-15-2-1"), FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        allAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-3-4"), FileSystemRights.ReadPermissions, AccessControlType.Allow));
        File.SetAccessControl(allPackages, allAcl);
        registryKey = scope.recovery.FixtureRegistry;
        RegistrySecurity privateAcl = new RegistrySecurity(); privateAcl.SetAccessRuleProtection(true, false);
        privateAcl.SetOwner(WindowsIdentity.GetCurrent().User);
        privateAcl.AddAccessRule(new RegistryAccessRule(WindowsIdentity.GetCurrent().User, RegistryRights.FullControl, InheritanceFlags.ContainerInherit, PropagationFlags.None, AccessControlType.Allow));
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(registryKey, RegistryKeyPermissionCheck.ReadWriteSubTree, RegistryOptions.None, privateAcl)) { key.SetValue("Fixture", "synthetic-private-value"); if ((string)key.GetValue("Fixture") != "synthetic-private-value") throw new InvalidDataException(); }
        scope.recovery.RegistryCreated();
        scope.privateRegistry = WindowsIdentity.GetCurrent().User.Value + "\\" + registryKey;
        string script = @"console.error('PHI_CONFINEMENT_ENTERED');const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const [work,scratch,runtime,secret,port,role]=process.argv.slice(1);
const result={role,workspaceRead:fs.readFileSync(path.join(work,'fixture.txt'),'utf8')==='synthetic-input'};
function denied(key,fn){try{fn();result[key]=false;}catch(e){result[key]=['EACCES','EPERM'].includes(e.code);}}
denied('hostReadDenied',()=>fs.readFileSync(path.join(secret,'.env')));
denied('hostWriteDenied',()=>fs.writeFileSync(path.join(secret,'escape.txt'),'synthetic'));
denied('runtimeWriteDenied',()=>fs.writeFileSync(path.join(runtime,'escape.txt'),'synthetic'));
denied('allPackagesReadDenied',()=>fs.readFileSync(path.join(runtime,'all-packages.txt')));
denied('extendedPathReadDenied',()=>fs.readFileSync(path.toNamespacedPath(path.join(secret,'.env'))));
denied('alternateStreamReadDenied',()=>fs.readFileSync(path.join(secret,'.env:fixture')));
denied('readOnlyAssetWriteDenied',()=>fs.appendFileSync(path.join(runtime,'read-only.txt'),'mutation'));
denied('runtimeRenameDenied',()=>fs.renameSync(path.join(runtime,'read-only.txt'),path.join(scratch,'stolen.txt')));
denied('existingJunctionReadDenied',()=>fs.readFileSync(path.join(scratch,'host-junction','.env')));
denied('existingPrivateHardlinkReadDenied',()=>fs.readFileSync(path.join(scratch,'host-private-link')));
result.existingReadOnlyHardlinkReadable=fs.readFileSync(path.join(scratch,'host-read-only-link'),'utf8')==='synthetic-read-only';
denied('existingReadOnlyHardlinkWriteDenied',()=>fs.appendFileSync(path.join(scratch,'host-read-only-link'),'mutation'));
function escapedLink(key,create,target,mutate){try{create();denied(key,()=>mutate?fs.appendFileSync(target,'mutation'):fs.readFileSync(target));}catch(e){result[key]=['EACCES','EPERM'].includes(e.code);}}
escapedLink('junctionEscapeDenied',()=>fs.symlinkSync(secret,path.join(scratch,'junction'),'junction'),path.join(scratch,'junction','.env'),false);
escapedLink('privateHardlinkEscapeDenied',()=>fs.linkSync(path.join(secret,'.env'),path.join(scratch,'private-link')),path.join(scratch,'private-link'),false);
escapedLink('readOnlyHardlinkWriteDenied',()=>fs.linkSync(path.join(runtime,'read-only.txt'),path.join(scratch,'read-only-link')),path.join(scratch,'read-only-link'),true);
result.cleanEnvironment=!Object.keys(process.env).some(k=>/TOKEN|SECRET|AUTH|API_KEY|PHI_PROBE/i.test(k));
console.error('PHI_CONFINEMENT_FILES_CHECKED');
try{fs.writeFileSync(path.join(scratch,'scratch.txt'),'synthetic');result.scratchWrite=true;}catch{result.scratchWrite=false;}
try{fs.writeFileSync(path.join(work,'edit.txt'),'synthetic');result.workspaceWrite=true;}catch(e){result.workspaceWrite=false;result.workspaceWriteDenied=['EACCES','EPERM'].includes(e.code);}
const s=net.connect({host:'127.0.0.1',port:Number(port)});s.setTimeout(1500);
console.error('PHI_CONFINEMENT_NETWORK_WAIT');
s.on('connect',()=>{result.networkDenied=false;s.destroy();finish();});
s.on('error',e=>{result.networkDenied=['EACCES','EPERM'].includes(e.code);finish();});
s.on('timeout',()=>{result.networkDenied=false;s.destroy();finish();});
let done=false;function finish(){if(done)return;done=true;console.log(JSON.stringify(result));process.exit(result.workspaceRead&&result.hostReadDenied&&result.hostWriteDenied&&result.runtimeWriteDenied&&result.allPackagesReadDenied&&result.extendedPathReadDenied&&result.alternateStreamReadDenied&&result.readOnlyAssetWriteDenied&&result.runtimeRenameDenied&&result.existingJunctionReadDenied&&result.existingPrivateHardlinkReadDenied&&result.existingReadOnlyHardlinkReadable&&result.existingReadOnlyHardlinkWriteDenied&&result.junctionEscapeDenied&&result.privateHardlinkEscapeDenied&&result.readOnlyHardlinkWriteDenied&&result.cleanEnvironment&&result.scratchWrite&&result.networkDenied&&(role==='worker'?result.workspaceWrite:!result.workspaceWrite&&result.workspaceWriteDenied)?0:1);}";
        if (failure == "hold-child") script = script.Replace("console.log(JSON.stringify(result));process.exit(", "console.log(JSON.stringify({...result,ownedPid:process.pid,scopeId:'" + scope.recovery.Id + "'}));setInterval(()=>{},1000);return;process.exit(");
        if (failure == "hold-tree" || failure == "timeout-tree") {
          // Pinned Node 22's libuv creates non-LOCAL named pipes; LPAC must
          // not be broadened to permit them. Inherit the three already-scoped
          // stdio handles for this tree. Generic piped tools need a broker.
          string leaf = @"const fs=require('node:fs'),path=require('node:path'),net=require('node:net');const [secret,scopeId,work,runtime,port]=process.argv.slice(1);const row={leafPid:process.pid,scopeId};function deny(key,fn){try{fn();row[key]=false;}catch(e){row[key]=['EACCES','EPERM'].includes(e.code);}}deny('nestedHostReadDenied',()=>fs.readFileSync(secret));deny('nestedAllPackagesDenied',()=>fs.readFileSync(path.join(runtime,'all-packages.txt')));try{fs.writeFileSync(path.join(work,'nested-edit.txt'),'synthetic');row.nestedWorkspaceWrite=true;}catch(e){row.nestedWorkspaceWrite=false;row.nestedWorkspaceWriteDenied=['EACCES','EPERM'].includes(e.code);}const s=net.connect({host:'127.0.0.1',port:Number(port)});s.setTimeout(1500);let done=false;function finish(value){if(done)return;done=true;row.nestedNetworkDenied=value;s.destroy();console.log(JSON.stringify(row));setInterval(()=>{},1000);}s.on('connect',()=>finish(false));s.on('error',e=>finish(['EACCES','EPERM'].includes(e.code)));s.on('timeout',()=>finish(false));";
          string middle = "const{spawn}=require('node:child_process');const [secret,scopeId,...rest]=process.argv.slice(1);console.log(JSON.stringify({middlePid:process.pid,scopeId}));const c=spawn(process.execPath,['--no-addons','-e'," + new JavaScriptSerializer().Serialize(leaf) + ",secret,scopeId,...rest],{shell:false,stdio:'inherit'});c.on('error',()=>{console.error('PHI_CONFINEMENT_CHILD_SPAWN_FAILED');process.exit(1);});setInterval(()=>{},1000);";
          string tree = "const{spawn}=require('node:child_process');console.log(JSON.stringify({...result,ownedPid:process.pid,scopeId:'" + scope.recovery.Id + "'}));const c=spawn(process.execPath,['--no-addons','-e'," + new JavaScriptSerializer().Serialize(middle) + ",path.join(secret,'.env'),'" + scope.recovery.Id + "',work,runtime,port],{shell:false,stdio:'inherit'});c.on('error',()=>{console.error('PHI_CONFINEMENT_CHILD_SPAWN_FAILED');process.exit(1);});setInterval(()=>{},1000);return;process.exit(";
          script = script.Replace("console.log(JSON.stringify(result));process.exit(", tree);
        }
        Dictionary<string, object> request = new Dictionary<string, object>();
        request["command"] = executable; request["cwd"] = workspace;
        request["args"] = new string[] { "--no-addons", "-e", script, workspace, scratch, runtime, secret, portText, role };
        string system = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        request["env"] = new Dictionary<string, string> {
          { "SystemRoot", system }, { "windir", system }, { "SystemDrive", Path.GetPathRoot(system).TrimEnd('\\') },
          { "PATH", runtime }, { "USERPROFILE", scratch }, { "LOCALAPPDATA", scratch }, { "APPDATA", scratch },
          { "TEMP", scratch }, { "TMP", scratch }
        };
        request["timeoutMs"] = failure == "timeout-tree" ? 4000 : 8000; request["guardianPid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
        // Execute requires an older guardian than the supervisor. The outer
        // Node guardian is provided by our process's inherited environment only
        // to this fixed probe, never exposed as sandbox authority.
        int guardian; if (!Int32.TryParse(Environment.GetEnvironmentVariable("PHI_PROBE_GUARDIAN"), out guardian)) throw new InvalidDataException();
        request["guardianPid"] = guardian;
        scope.guardianPid = (uint)guardian;
        scope.recovery.Ready();
        if (scope.RunAllPackagesControl(request, runtime, allPackages) != 0) throw new InvalidOperationException("PHI_APPCONTAINER_CONTROL_FAILED");
        byte[] input = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(request) + "\n");
        using (MemoryStream stream = new MemoryStream(input)) code = OwnedProcess.Execute(stream, scope);
        if (!scope.TokenVerified) code = 70;
        if (File.ReadAllText(Path.Combine(secret, ".env")) != "SYNTHETIC_PRIVATE_PROBE_ONLY" || File.ReadAllText(scope.readOnlyAsset) != "synthetic-read-only") code = 70;
        if (failure == "before-cleanup") throw new InvalidOperationException("PHI_RECOVERY_INJECTED_BEFORE_CLEANUP");
      } catch (Win32Exception ex) { Console.Error.WriteLine("PHI_APPCONTAINER_FAILED:" + ex.NativeErrorCode); code = 70; }
        catch { Console.Error.WriteLine("PHI_APPCONTAINER_PROBE_FAILED"); code = 70; }
      finally {
        bool profileClean = true, filesClean = true, registryClean = true;
        try { if (scope != null) scope.Dispose(); } catch { profileClean = false; Console.Error.WriteLine("PHI_APPCONTAINER_PROFILE_CLEANUP_FAILED"); }
        // Unlink the exact fresh controller-created junction non-recursively
        // BEFORE deleting its tree. Never enumerate or delete through a link.
        // This avoids .NET Framework's recursive mount-point cleanup path.
        try {
          if (ownedJunction != null && !RemoveDirectoryW(ownedJunction)) {
            int error = Marshal.GetLastWin32Error(); if (error != 2 && error != 3) throw new Win32Exception(error);
          }
          if (aliasesReady && File.ReadAllText(Path.Combine(root, "host-private", ".env")) != "SYNTHETIC_PRIVATE_PROBE_ONLY") throw new InvalidDataException();
        } catch { filesClean = false; Console.Error.WriteLine("PHI_APPCONTAINER_JUNCTION_CLEANUP_FAILED"); }
        try {
          if (failure == "cleanup-exception") throw new InvalidOperationException("PHI_RECOVERY_INJECTED_CLEANUP_EXCEPTION");
          if (root != null) scope.recovery.CleanupFiles();
        } catch (Exception error) { filesClean = false; RecoveryFilesystem.LogFailure(error); Console.Error.WriteLine("PHI_APPCONTAINER_FILES_CLEANUP_FAILED"); }
        try { if (registryKey != null) Registry.CurrentUser.DeleteSubKeyTree(registryKey); } catch { registryClean = false; Console.Error.WriteLine("PHI_APPCONTAINER_REGISTRY_CLEANUP_FAILED"); }
        cleaned = profileClean && filesClean && registryClean;
        if (!cleaned) { Console.Error.WriteLine("PHI_APPCONTAINER_CLEANUP_FAILED"); code = 70; }
        try { if (scope != null) scope.recovery.Complete(cleaned); } catch { cleaned = false; code = 70; Console.Error.WriteLine("PHI_RECOVERY_JOURNAL_FAILED"); }
      }
      Console.WriteLine(new JavaScriptSerializer().Serialize(new { tokenVerified = scope != null && scope.TokenVerified, cleanup = cleaned ? "PASS" : "FAIL", scope = "FIXED_SYNTHETIC_PROBE_ONLY", scopeId = scope == null ? null : scope.profile.Substring("Phi.Probe.".Length) }));
      return code;
    }
  }
}
