// Trusted process ownership ONLY. This is not filesystem/network confinement.
// Autonomous execution remains blocked until a separate sandbox is attested.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Phi.Native {
  public static class OwnedProcess {
    const uint KillOnClose = 0x2000, ActiveProcessLimit = 8, DieOnException = 0x400;
    const uint ExtendedStartup = 0x80000, UnicodeEnvironment = 0x400, Suspended = 4, NoWindow = 0x08000000;
    const int MaxRequest = 1024 * 1024, MaxLifetime = 120000;
    const long HandleListAttribute = 0x20002, JobListAttribute = 0x2000d;
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
      public long PerProcessUserTime, PerJobUserTime;
      public uint Flags;
      public UIntPtr MinWorkingSet, MaxWorkingSet;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
      public BasicLimits Basic; public IoCounters Io;
      public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
      public long TotalUser, TotalKernel, PeriodUser, PeriodKernel;
      public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
      public int Size; public string Reserved, Desktop, Title;
      public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
      public ushort ShowWindow, ReservedCount; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Size; public IntPtr Descriptor; public int Inherit; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inside);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr duplicate, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    static string StringValue(object value) {
      string text = value as string;
      if (text == null || text.IndexOf('\0') >= 0) throw new InvalidDataException();
      return text;
    }
    // Windows CRT argument encoding, never cmd.exe/PowerShell string execution.
    static string Quote(string value) {
      StringBuilder result = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') result.Append('\\', slashes * 2 + 1).Append('"');
        else result.Append('\\', slashes).Append(c);
        slashes = 0;
      }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static string ReadRequest(Stream input) {
      using (MemoryStream buffer = new MemoryStream()) {
        for (int i = 0; i <= MaxRequest; i++) {
          int next = input.ReadByte();
          if (next < 0) throw new InvalidDataException();
          if (next == 10) return new UTF8Encoding(false, true).GetString(buffer.ToArray());
          buffer.WriteByte((byte)next);
        }
      }
      throw new InvalidDataException();
    }
    static bool EmptyJob(IntPtr job) {
      Accounting info;
      Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      return info.ActiveProcesses == 0;
    }
    public static int Main(string[] args) {
      if (args.Length == 1 && args[0] == "--version") { Console.WriteLine("Phi owned-process ABI 1; Windows Job Object; NOT a sandbox"); return 0; }
      if (args.Length == 4 && args[0] == "--confinement-probe") return AppContainerScope.Probe(args[1], args[2], args[3]);
      // API capability checks below fail closed on pre-Windows-10 systems.
      // Unmanifested .NET Framework OSVersion can report a legacy version.
      if (args.Length != 0 || IntPtr.Size != 8) return 70;
      return Execute(Console.OpenStandardInput(), null);
    }
    // Only the fixed native probe can supply confinement. No model/tool input
    // can request a full-trust fallback from this entry point.
    internal static int Execute(Stream input, AppContainerScope scope) {
      IntPtr job = IntPtr.Zero, list = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
      IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
      IntPtr guardian = IntPtr.Zero;
      ProcessInfo child = new ProcessInfo(); bool listReady = false;
      string phase = "REQUEST";
      try {
        JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = MaxRequest;
        Dictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(ReadRequest(input));
        string[] keys = { "command", "args", "cwd", "env", "timeoutMs", "guardianPid" };
        if (request == null || request.Count != keys.Length || keys.Any(k => !request.ContainsKey(k))) throw new InvalidDataException();
        string command = StringValue(request["command"]), cwd = StringValue(request["cwd"]);
        if (!Path.IsPathRooted(command) || command.StartsWith("\\\\") || !command.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !Path.IsPathRooted(cwd) || cwd.StartsWith("\\\\")) throw new InvalidDataException();
        System.Collections.IList arguments = request["args"] as System.Collections.IList;
        if (arguments == null || arguments.Count > 256) throw new InvalidDataException();
        StringBuilder encoded = new StringBuilder(Quote(command));
        foreach (object argument in arguments) encoded.Append(' ').Append(Quote(StringValue(argument)));
        if (encoded.Length > 30000) throw new InvalidDataException();
        if (!(request["timeoutMs"] is int)) throw new InvalidDataException();
        int timeout = (int)request["timeoutMs"];
        if (timeout < 1 || timeout > MaxLifetime) throw new InvalidDataException();
        if (!(request["guardianPid"] is int) || (int)request["guardianPid"] < 1) throw new InvalidDataException();
        guardian = OpenProcess(0x00100000 | 0x1000, false, (uint)(int)request["guardianPid"]); Check(guardian != IntPtr.Zero);
        FileTime parentCreated, selfCreated, unused1, unused2, unused3;
        Check(GetProcessTimes(guardian, out parentCreated, out unused1, out unused2, out unused3));
        Check(GetProcessTimes(GetCurrentProcess(), out selfCreated, out unused1, out unused2, out unused3));
        // Reject reused guardian PIDs; thereafter wait on the generation-bound handle.
        if (parentCreated.Value >= selfCreated.Value || WaitForSingleObject(guardian, 0) != 258) throw new InvalidDataException();
        Dictionary<string, object> env = request["env"] as Dictionary<string, object>;
        if (env == null || env.Count > 512) throw new InvalidDataException();
        SortedDictionary<string, string> sorted = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, object> pair in env) {
          if (pair.Key.Length == 0 || pair.Key.IndexOfAny(new char[] {'=', '\0'}) >= 0 || sorted.ContainsKey(pair.Key)) throw new InvalidDataException();
          sorted.Add(pair.Key, StringValue(pair.Value));
        }
        string block = String.Join("\0", sorted.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
        if (block.Length > 32760) throw new InvalidDataException();
        environment = Marshal.StringToHGlobalUni(block);
        phase = "JOB";
        job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero);
        ExtendedLimits limits = new ExtendedLimits();
        // No BREAKAWAY_OK or SILENT_BREAKAWAY_OK. Native limits are not input-controlled.
        limits.Basic.Flags = KillOnClose | ActiveProcessLimit | DieOnException;
        limits.Basic.ActiveProcessLimit = 32;
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
        phase = "STDIO";
        SecurityAttributes security = new SecurityAttributes(); security.Size = Marshal.SizeOf(typeof(SecurityAttributes)); security.Inherit = 1;
        Check(CreatePipe(out inputRead, out inputWrite, ref security, 0));
        Check(SetHandleInformation(inputWrite, 1, 0));
        IntPtr self = GetCurrentProcess();
        Check(DuplicateHandle(self, GetStdHandle(-11), self, out output, 0, true, 2));
        Check(DuplicateHandle(self, GetStdHandle(-12), self, out error, 0, true, 2));
        phase = "ATTRIBUTES";
        IntPtr size = IntPtr.Zero;
        int attributeCount = scope == null ? 2 : 4;
        InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
        if (size == IntPtr.Zero) throw new InvalidDataException();
        list = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list, attributeCount, 0, ref size)); listReady = true;
        if (scope != null) scope.ApplyAttributes(list);
        jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(JobListAttribute), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
        handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
        Marshal.WriteIntPtr(handles, 0, inputRead); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
        Check(UpdateProcThreadAttribute(list, 0, new IntPtr(HandleListAttribute), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
        StartupEx startup = new StartupEx(); startup.Startup.Size = Marshal.SizeOf(typeof(StartupEx)); startup.Startup.Flags = 0x100;
        startup.Startup.Input = inputRead; startup.Startup.Output = output; startup.Startup.Error = error; startup.Attributes = list;
        // Atomic job assignment at CreateProcess closes the suspended-unassigned orphan window.
        phase = "CREATE";
        Check(CreateProcessW(command, encoded, IntPtr.Zero, IntPtr.Zero, true, ExtendedStartup | UnicodeEnvironment | Suspended | NoWindow, environment, cwd, ref startup, out child));
        phase = "ATTEST";
        bool inside; Check(IsProcessInJob(child.Process, job, out inside)); if (!inside) throw new InvalidDataException();
        if (scope != null) scope.VerifyToken(child.Process);
        Close(ref inputRead); Close(ref output); Close(ref error);
        SafeFileHandle writeHandle = new SafeFileHandle(inputWrite, true); inputWrite = IntPtr.Zero;
        Thread copy = new Thread(delegate() {
          try { using (FileStream pipe = new FileStream(writeHandle, FileAccess.Write)) input.CopyTo(pipe); }
          catch (IOException) { } catch (ObjectDisposedException) { } catch (ArgumentException) { }
          finally { writeHandle.Dispose(); }
        }); copy.IsBackground = true; copy.Start();
        phase = "RESUME";
        if (ResumeThread(child.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint waited = WaitForMultipleObjects(2, new IntPtr[] { child.Process, guardian }, false, (uint)timeout);
        if (waited != 0 && waited != 1 && waited != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint code = waited == 1 ? 125U : 124U;
        if (waited == 0) Check(GetExitCodeProcess(child.Process, out code));
        // A successful parent exit is not evidence that descendants finished.
        phase = "CLEANUP";
        Check(TerminateJobObject(job, 137));
        DateTime deadline = DateTime.UtcNow.AddSeconds(5);
        while (!EmptyJob(job)) { if (DateTime.UtcNow >= deadline) throw new InvalidDataException(); Thread.Sleep(10); }
        writeHandle.Dispose();
        return code <= 255 ? (int)code : 1;
      } catch (Win32Exception ex) { Console.Error.WriteLine("PHI_NATIVE_PROCESS_FAILED:" + ex.NativeErrorCode + ":" + phase); return 70; }
        catch { Console.Error.WriteLine("PHI_NATIVE_PROCESS_INVALID_OR_CLEANUP_FAILED:" + phase); return 70; }
      finally {
        // Closing the non-inherited last Job handle kills owned children even on exception.
        Close(ref job); Close(ref child.Thread); Close(ref child.Process); Close(ref guardian);
        Close(ref inputRead); Close(ref inputWrite); Close(ref output); Close(ref error);
        if (listReady) DeleteProcThreadAttributeList(list);
        foreach (IntPtr pointer in new IntPtr[] { list, jobs, handles, environment }) if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
      }
    }
  }
}
