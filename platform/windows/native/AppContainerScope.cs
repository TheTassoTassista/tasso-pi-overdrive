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

namespace Phi.Native {
  internal sealed class AppContainerScope : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Capabilities {
      public IntPtr Sid, Entries; public uint Count, Reserved;
    }
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int type, out uint value, uint size, out uint returned);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name, uint type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
    readonly string profile;
    readonly IntPtr sid;
    IntPtr capabilities, policy;
    bool disposed;
    internal bool TokenVerified { get; private set; }
    internal AppContainerScope() {
      profile = "Phi.Probe." + Guid.NewGuid().ToString("N");
      int result = CreateAppContainerProfile(profile, "Phi isolated probe", "Synthetic confinement validation only", IntPtr.Zero, 0, out sid);
      if (result != 0 || sid == IntPtr.Zero) throw new InvalidOperationException("PHI_APPCONTAINER_PROFILE_FAILED");
      try {
        Capabilities value = new Capabilities(); value.Sid = sid; // zero capabilities, including network
        capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Capabilities)));
        Marshal.StructureToPtr(value, capabilities, false);
        policy = Marshal.AllocHGlobal(4); Marshal.WriteInt32(policy, 1); // ALL_APPLICATION_PACKAGES opt-out / LPAC
      } catch { Dispose(); throw; }
    }
    internal void ApplyAttributes(IntPtr list) {
      if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x20009), capabilities, new IntPtr(Marshal.SizeOf(typeof(Capabilities))), IntPtr.Zero, IntPtr.Zero) ||
          !UpdateProcThreadAttribute(list, 0, new IntPtr(0x2000f), policy, new IntPtr(4), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    internal void VerifyToken(IntPtr process) {
      IntPtr token; if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        uint value, returned;
        if (!GetTokenInformation(token, 29, out value, 4, out returned) || returned != 4 || value != 1 ||
            !GetTokenInformation(token, 46, out value, 4, out returned) || returned != 4 || value != 1) throw new InvalidOperationException("PHI_APPCONTAINER_TOKEN_REJECTED");
        TokenVerified = true;
      } finally { CloseHandle(token); }
    }
    static void LowLabel(string directory) {
      IntPtr descriptor = IntPtr.Zero;
      try {
        uint size; bool present, defaulted; IntPtr sacl;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;OICI;NW;;;LW)", 1, out descriptor, out size) ||
            !GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted) || !present) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint result = SetNamedSecurityInfoW(directory, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
        if (result != 0) throw new Win32Exception((int)result);
      } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    internal void SetDirectoryAuthority(string directory, bool readable, bool writable) {
      // ONLY fresh controller-owned synthetic directories. No recursive host ACL
      // mutation. No generic caller-supplied path or role overrides are exposed.
      if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
      DirectorySecurity acl = new DirectorySecurity(); acl.SetAccessRuleProtection(true, false);
      InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
      SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
      foreach (SecurityIdentifier identity in new SecurityIdentifier[] { user, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
        acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
      // Suppress implicit owner WRITE_DAC in the restricted token.
      acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-3-4"), FileSystemRights.ReadPermissions, inherit, PropagationFlags.None, AccessControlType.Allow));
      if (readable) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), writable ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
      Directory.SetAccessControl(directory, acl);
      if (writable) LowLabel(directory);
    }
    public void Dispose() {
      if (disposed) return; disposed = true;
      int result = DeleteAppContainerProfile(profile);
      if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
      if (policy != IntPtr.Zero) Marshal.FreeHGlobal(policy);
      if (sid != IntPtr.Zero) FreeSid(sid);
      if (result != 0) throw new InvalidOperationException("PHI_APPCONTAINER_CLEANUP_FAILED");
    }
    internal static int Probe(string node, string role, string portText) {
      if (IntPtr.Size != 8 || (role != "worker" && role != "tester" && role != "reviewer")) return 70;
      int port;
      if (!Int32.TryParse(portText, out port) || port < 1 || port > 65535 || !Path.IsPathRooted(node) || node.StartsWith("\\\\") || !node.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return 70;
      string root = null; AppContainerScope scope = null; int code = 70; bool cleaned = false;
      try {
        if ((File.GetAttributes(node) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
        scope = new AppContainerScope();
        root = Path.Combine(Path.GetTempPath(), "phi-lpac-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root); scope.SetDirectoryAuthority(root, true, false);
        string runtime = Path.Combine(root, "runtime"), workspace = Path.Combine(root, "workspace"), scratch = Path.Combine(root, "scratch"), secret = Path.Combine(root, "host-private");
        foreach (string directory in new string[] { runtime, workspace, scratch, secret }) Directory.CreateDirectory(directory);
        scope.SetDirectoryAuthority(runtime, true, false); scope.SetDirectoryAuthority(workspace, true, role == "worker");
        scope.SetDirectoryAuthority(scratch, true, true); scope.SetDirectoryAuthority(secret, false, false);
        string executable = Path.Combine(runtime, "node.exe"); File.Copy(node, executable, false);
        File.WriteAllText(Path.Combine(workspace, "fixture.txt"), "synthetic-input");
        File.WriteAllText(Path.Combine(secret, ".env"), "SYNTHETIC_PRIVATE_PROBE_ONLY");
        string script = @"const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const [work,scratch,runtime,secret,port,role]=process.argv.slice(1);
const result={role,workspaceRead:fs.readFileSync(path.join(work,'fixture.txt'),'utf8')==='synthetic-input'};
function denied(key,fn){try{fn();result[key]=false;}catch(e){result[key]=['EACCES','EPERM'].includes(e.code);}}
denied('hostReadDenied',()=>fs.readFileSync(path.join(secret,'.env')));
denied('hostWriteDenied',()=>fs.writeFileSync(path.join(secret,'escape.txt'),'synthetic'));
denied('runtimeWriteDenied',()=>fs.writeFileSync(path.join(runtime,'escape.txt'),'synthetic'));
try{fs.writeFileSync(path.join(scratch,'scratch.txt'),'synthetic');result.scratchWrite=true;}catch{result.scratchWrite=false;}
try{fs.writeFileSync(path.join(work,'edit.txt'),'synthetic');result.workspaceWrite=true;}catch(e){result.workspaceWrite=false;result.workspaceWriteDenied=['EACCES','EPERM'].includes(e.code);}
const s=net.connect({host:'127.0.0.1',port:Number(port)});s.setTimeout(1500);
s.on('connect',()=>{result.networkDenied=false;s.destroy();finish();});
s.on('error',e=>{result.networkDenied=['EACCES','EPERM'].includes(e.code);finish();});
s.on('timeout',()=>{result.networkDenied=false;s.destroy();finish();});
let done=false;function finish(){if(done)return;done=true;console.log(JSON.stringify(result));process.exit(result.workspaceRead&&result.hostReadDenied&&result.hostWriteDenied&&result.runtimeWriteDenied&&result.scratchWrite&&result.networkDenied&&(role==='worker'?result.workspaceWrite:!result.workspaceWrite&&result.workspaceWriteDenied)?0:1);}";
        Dictionary<string, object> request = new Dictionary<string, object>();
        request["command"] = executable; request["cwd"] = workspace;
        request["args"] = new string[] { "--no-addons", "-e", script, workspace, scratch, runtime, secret, portText, role };
        request["env"] = new Dictionary<string, string> { { "SystemRoot", Environment.GetEnvironmentVariable("SystemRoot") }, { "TEMP", scratch }, { "TMP", scratch } };
        request["timeoutMs"] = 8000; request["guardianPid"] = System.Diagnostics.Process.GetCurrentProcess().Id;
        // Execute requires an older guardian than the supervisor. The outer
        // Node guardian is provided by our process's inherited environment only
        // to this fixed probe, never exposed as sandbox authority.
        int guardian; if (!Int32.TryParse(Environment.GetEnvironmentVariable("PHI_PROBE_GUARDIAN"), out guardian)) throw new InvalidDataException();
        request["guardianPid"] = guardian;
        byte[] input = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(request) + "\n");
        using (MemoryStream stream = new MemoryStream(input)) code = OwnedProcess.Execute(stream, scope);
        if (!scope.TokenVerified) code = 70;
      } catch (Win32Exception ex) { Console.Error.WriteLine("PHI_APPCONTAINER_FAILED:" + ex.NativeErrorCode); code = 70; }
        catch { Console.Error.WriteLine("PHI_APPCONTAINER_PROBE_FAILED"); code = 70; }
      finally {
        try { if (scope != null) scope.Dispose(); if (root != null) Directory.Delete(root, true); cleaned = true; }
        catch { Console.Error.WriteLine("PHI_APPCONTAINER_CLEANUP_FAILED"); code = 70; }
      }
      Console.WriteLine(new JavaScriptSerializer().Serialize(new { tokenVerified = scope != null && scope.TokenVerified, cleanup = cleaned ? "PASS" : "FAIL", scope = "FIXED_SYNTHETIC_PROBE_ONLY" }));
      return code;
    }
  }
}
