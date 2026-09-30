// Trusted process ownership ONLY. This is not filesystem/network confinement.
// Autonomous execution remains blocked until a separate sandbox is attested.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
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
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessIoCounters(IntPtr process, out IoCounters counters);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessHandleCount(IntPtr process, out uint count);
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
      if (args.Length == 1 && args[0] == "--recover-scopes") return ScopeRecovery.Recover(true, null);
      if (args.Length == 1 && args[0] == "--scope-recovery-status") return ScopeRecovery.Status(true);
      if (args.Length == 2 && args[0] == "--recover-scope") return ScopeRecovery.Recover(true, args[1]);
      if (args.Length == 2 && args[0] == "--recovery-selftest") return ScopeRecovery.SelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--anchored-file-selftest") return AnchoredFile.SelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--atomic-create-selftest") return AnchoredFile.AtomicCreateSelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--atomic-modify-selftest") return AtomicModify.SelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--rename-primitive-selftest") return PublicationJournal.RenamePrimitiveSelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--publication-journal-selftest") return PublicationJournal.SelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--publication-journal-fixture-child") return PublicationJournal.FixtureChild(args[1]);
      if (args.Length == 1 && args[0] == "--publication-journal-fixture-inspect") return PublicationJournal.FixtureInspect();
      if (args.Length == 2 && args[0] == "--publication-modify-selftest") return PublicationJournal.ModifySelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--publication-modify-fixture-child") return PublicationJournal.ModifyFixtureChild(args[1]);
      if (args.Length == 1 && args[0] == "--publication-modify-fixture-recover") return PublicationJournal.ModifyFixtureRecover();
      if (args.Length == 1 && args[0] == "--publication-modify" && IntPtr.Size == 8) return PublicationJournal.RunSingleModify(Console.OpenStandardInput());
      if (args.Length == 1 && args[0] == "--publication-delete" && IntPtr.Size == 8) return PublicationJournal.RunSingleDelete(Console.OpenStandardInput());
      if (args.Length == 2 && args[0] == "--publication-delete-selftest") return PublicationJournal.DeleteSelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--publication-delete-fixture-child") return PublicationJournal.DeleteFixtureChild(args[1]);
      if (args.Length == 1 && args[0] == "--publication-delete-fixture-recover") return PublicationJournal.DeleteFixtureRecover();
      if (args.Length == 1 && args[0] == "--publication-rename" && IntPtr.Size == 8) return PublicationJournal.RunSingleRename(Console.OpenStandardInput());
      if (args.Length == 1 && args[0] == "--publication-inspect-known" && IntPtr.Size == 8) return PublicationJournal.InspectKnownTransaction(Console.OpenStandardInput());
      if (args.Length == 1 && args[0] == "--publication-discover" && IntPtr.Size == 8) return PublicationJournal.DiscoverProjectTransactions(Console.OpenStandardInput());
      if (args.Length == 2 && args[0] == "--publication-discovery-selftest") return PublicationJournal.DiscoverySelfTest(args[1]);
      if (args.Length == 1 && args[0] == "--publication-recover-known" && IntPtr.Size == 8) return PublicationJournal.RecoverKnownTransaction(Console.OpenStandardInput());
      if (args.Length == 2 && args[0] == "--publication-rename-selftest") return PublicationJournal.RenameSelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--publication-rename-controller-recovery-selftest") return PublicationJournal.RenameControllerRecoverySelfTest(args[1]);
      if (args.Length == 2 && args[0] == "--publication-rename-fixture-child") return PublicationJournal.RenameFixtureChild(args[1]);
      if (args.Length == 1 && args[0] == "--publication-rename-fixture-recover") return PublicationJournal.RenameFixtureRecover();
      if (args.Length == 5 && args[0] == "--confinement-failure-probe") return AppContainerScope.Probe(args[1], args[2], args[3], args[4]);
      if (args.Length == 1 && args[0] == "--lpac-broker" && IntPtr.Size == 8) return ExecutionBroker.Run(Console.OpenStandardInput());
      if (args.Length == 1 && args[0] == "--project-snapshot" && IntPtr.Size == 8) return ExecutionBroker.Snapshot(Console.OpenStandardInput());
      if (args.Length == 1 && args[0] == "--validation-run" && IntPtr.Size == 8) return ValidationRun();
      if (args.Length == 3 && args[0] == "--validation-lock") return ValidationLock(args[1], args[2]);
      if (args.Length == 3 && args[0] == "--validation-inherited-lock") {
        IntPtr held = IntPtr.Zero;
        try {
          long value; uint flags;
          if (!Int64.TryParse(args[1], out value)) return 70;
          held = new IntPtr(value);
          Check(GetHandleInformation(held, out flags)); if ((flags & 1) == 0) return 70;
          string root = Path.GetFullPath(args[2]);
          if (!String.Equals(Path.GetDirectoryName(root), Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(root).StartsWith("phi-clone-cleanup-", StringComparison.Ordinal)) return 70;
          ValidationDenial(root, false, true);
          Thread.Sleep(1200); return 0;
        } catch { return 70; } finally { Close(ref held); }
      }
      // API capability checks below fail closed on pre-Windows-10 systems.
      // Unmanifested .NET Framework OSVersion can report a legacy version.
      if (args.Length != 0 || IntPtr.Size != 8) return 70;
      return Execute(Console.OpenStandardInput(), null);
    }
    internal static void WithPublicationGuardian(int pid, int timeout, Action<Action> action) {
      // Trusted native publisher only, not a model execution/sandbox endpoint.
      // Same generation-bound guardian semantics as owned execution, but this
      // process never spawns a workload. Its own death aborts an uncommitted KTM.
      if (pid < 1 || timeout < 1 || timeout > 30000) throw new InvalidDataException();
      IntPtr guardian = OpenProcess(0x00100000 | 0x1000, false, (uint)pid); Check(guardian != IntPtr.Zero);
      try {
        FileTime parentCreated, selfCreated, unused1, unused2, unused3;
        Check(GetProcessTimes(guardian, out parentCreated, out unused1, out unused2, out unused3));
        Check(GetProcessTimes(GetCurrentProcess(), out selfCreated, out unused1, out unused2, out unused3));
        if (parentCreated.Value >= selfCreated.Value || WaitForSingleObject(guardian, 0) != 258) throw new InvalidDataException();
        Stopwatch lifetime = Stopwatch.StartNew();
        using (ManualResetEvent stop = new ManualResetEvent(false)) {
          Action live = delegate() { if (lifetime.ElapsedMilliseconds >= timeout || WaitForSingleObject(guardian, 0) != 258) throw new InvalidOperationException("PHI_PUBLICATION_GUARDIAN_UNAVAILABLE"); };
          Thread watch = new Thread(delegate() { while (!stop.WaitOne(20)) { if (lifetime.ElapsedMilliseconds >= timeout || WaitForSingleObject(guardian, 0) != 258) { Process.GetCurrentProcess().Kill(); return; } } });
          watch.IsBackground = true; watch.Start();
          try { live(); action(live); live(); }
          finally { stop.Set(); if (!watch.Join(1000)) throw new InvalidDataException(); }
        }
      } finally { Close(ref guardian); }
    }
    // Fixed probes and the structured broker supply confinement. Neither can
    // request a full-trust fallback; bare ownership remains a separate API.
    internal sealed class Capture {
      internal readonly MemoryStream Output = new MemoryStream(), Error = new MemoryStream();
      internal readonly EventWaitHandle Overflow = new EventWaitHandle(false, EventResetMode.ManualReset);
      internal bool JobAttested, Started, Drained, JobEmptyVerified, TimedOut;
      internal int? PrimaryExitCode;
      internal uint ChildPid;
      internal string ChildGeneration;
      internal Action<byte[], int> OnOutput;
      internal Action OnStarted;
      internal InstallObservation Install;
      int bytes;
      internal Thread Drain(IntPtr handle, MemoryStream destination) {
        Thread thread = new Thread(delegate() {
          try {
            using (FileStream pipe = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read)) {
              byte[] block = new byte[8192]; int count;
              while ((count = pipe.Read(block, 0, block.Length)) != 0) {
                if (Interlocked.Add(ref bytes, count) > 2 * 1024 * 1024) { Overflow.Set(); break; }
                destination.Write(block, 0, count);
                if (Install != null) Install.Data(destination == Output, count);
                if (destination == Output && OnOutput != null) OnOutput(block, count);
              }
            }
          } catch { Overflow.Set(); }
        });
        thread.IsBackground = true; thread.Start(); return thread;
      }
    }
    // Read-only observations of the SAME owned Job, for the fixed trusted clone
    // install only. No extra process, target argument/environment change, wait
    // budget, signal, retry, filesystem authority or agent endpoint is added.
    internal sealed class InstallObservation {
      readonly Stopwatch clock = Stopwatch.StartNew();
      readonly object sync = new object();
      readonly List<object> phases = new List<object>(), snapshots = new List<object>(), streamEvents = new List<object>();
      readonly Dictionary<string, object> seen = new Dictionary<string, object>();
      readonly ManualResetEvent stop = new ManualResetEvent(false);
      Thread observer;
      bool observerStopped = true;
      long outBytes, errBytes;
      long? firstOutput, lastOutput, firstError, lastError;
      internal void Phase(string name) { lock (sync) phases.Add(new { phase = name, utc = DateTime.UtcNow.ToString("o"), elapsedMs = clock.ElapsedMilliseconds }); }
      internal void Data(bool stdout, int count) {
        lock (sync) {
          long elapsed = clock.ElapsedMilliseconds;
          if (streamEvents.Count < 256) streamEvents.Add(new { stream = stdout ? "stdout" : "stderr", offset = stdout ? outBytes : errBytes, bytes = count, utc = DateTime.UtcNow.ToString("o"), elapsedMs = elapsed });
          if (stdout) { outBytes += count; if (!firstOutput.HasValue) firstOutput = elapsed; lastOutput = elapsed; }
          else { errBytes += count; if (!firstError.HasValue) firstError = elapsed; lastError = elapsed; }
        }
      }
      object StreamProgress() { return new { stdoutBytes = outBytes, stderrBytes = errBytes, firstStdoutMs = firstOutput, lastStdoutMs = lastOutput, firstStderrMs = firstError, lastStderrMs = lastError }; }
      object[] Processes(IntPtr job) {
        // JobBasicProcessIdList; 32 is the EXISTING enforced active-process cap.
        IntPtr buffer = Marshal.AllocHGlobal(8 + 32 * IntPtr.Size);
        try {
          if (!QueryInformationJobObject(job, 3, buffer, (uint)(8 + 32 * IntPtr.Size), IntPtr.Zero)) return new object[] { new { observationError = Marshal.GetLastWin32Error() } };
          int count = Marshal.ReadInt32(buffer, 4);
          if (count < 0 || count > 32) return new object[] { new { observationError = -1 } };
          List<object> rows = new List<object>();
          for (int i = 0; i < count; i++) {
            uint pid = (uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
            IntPtr handle = OpenProcess(0x00100000 | 0x1000, false, pid);
            try {
              bool owned; FileTime created, exited, kernel, user; uint exit, handles; IoCounters io;
              if (handle == IntPtr.Zero || !IsProcessInJob(handle, job, out owned) || !owned || !GetProcessTimes(handle, out created, out exited, out kernel, out user) || !GetExitCodeProcess(handle, out exit)) { rows.Add(new { pid, observationError = Marshal.GetLastWin32Error() }); continue; }
              bool hasIo = GetProcessIoCounters(handle, out io), hasHandles = GetProcessHandleCount(handle, out handles);
              string image = "UNKNOWN"; Dictionary<string, int> waits = new Dictionary<string, int>();
              // Metadata only; the generation-bound owned handle, not a PID,
              // remains the authority. Never terminate an observed PID.
              try { using (Process process = Process.GetProcessById((int)pid)) {
                image = process.ProcessName;
                foreach (ProcessThread thread in process.Threads) using (thread) {
                  string state; try { state = thread.ThreadState == System.Diagnostics.ThreadState.Wait ? "Wait:" + thread.WaitReason.ToString() : thread.ThreadState.ToString(); } catch { state = "UNKNOWN"; }
                  if (!waits.ContainsKey(state)) waits[state] = 0; waits[state]++;
                }
              } } catch { waits["UNKNOWN"] = 1; }
              string generation = created.Value.ToString();
              object row = new { pid, generation, image, observedExitCode = exit, signaled = WaitForSingleObject(handle, 0) == 0,
                kernel100ns = kernel.Value, user100ns = user.Value, ioAvailable = hasIo, readOps = io.ReadOps, writeOps = io.WriteOps, readBytes = io.ReadBytes, writeBytes = io.WriteBytes,
                handlesAvailable = hasHandles, handleCount = handles, threadStates = waits };
              rows.Add(row);
              lock (sync) { string key = pid + ":" + generation; if (!seen.ContainsKey(key) && seen.Count < 128) seen.Add(key, new { pid, generation, image, firstObservedMs = clock.ElapsedMilliseconds }); }
            } finally { Close(ref handle); }
          }
          return rows.ToArray();
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      internal void Snapshot(IntPtr job, string point) {
        try {
          Accounting accounting; bool counted = QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero);
          object[] processes = Processes(job);
          lock (sync) { if (snapshots.Count < 8) snapshots.Add(new { point, utc = DateTime.UtcNow.ToString("o"), elapsedMs = clock.ElapsedMilliseconds, accountingAvailable = counted,
            totalCreated = accounting.TotalProcesses, active = accounting.ActiveProcesses, terminated = accounting.TerminatedProcesses, processes, streams = StreamProgress() }); }
        } catch { lock (sync) { if (snapshots.Count < 8) snapshots.Add(new { point, elapsedMs = clock.ElapsedMilliseconds, observationError = "UNKNOWN" }); } }
      }
      internal void Start(IntPtr job) {
        observerStopped = false;
        observer = new Thread(delegate() {
          Snapshot(job, "RESUMED");
          int samples = 0;
          while (!stop.WaitOne(1000)) {
            try { Processes(job); } catch { }
            if (++samples % 30 == 0) Snapshot(job, "RUNNING");
          }
        }); observer.IsBackground = true; observer.Start();
      }
      internal void Stop() { stop.Set(); observerStopped = observer == null || observer.Join(1000); }
      internal object Result() { lock (sync) return new { version = 1, scope = "FIXED_TRUSTED_LSP_INSTALL_OBSERVATION_NOT_SANDBOX", phases = phases.ToArray(), snapshots = snapshots.ToArray(), observedProcesses = seen.Values.ToArray(), processEnumeration = "OWNED_JOB_ONLY_SAMPLED_NOT_EXHAUSTIVE", observerStopped, streamEvents = streamEvents.ToArray(), streamEventsBound = 256, streams = StreamProgress() }; }
    }
    // Controller validation only, NOT an agent tool or a sandbox. The longer
    // aggregate-suite budget is available only to the fixed tracked check entry;
    // every ordinary request and every LPAC request retains MaxLifetime.
    static int ValidationRun() {
      Capture capture = new Capture();
      int code = Execute(Console.OpenStandardInput(), null, capture, true);
      if (capture.Install != null) Console.Error.WriteLine("PHI_LSP_INSTALL_DIAGNOSTIC:" + new JavaScriptSerializer().Serialize(capture.Install.Result()));
      Console.WriteLine(new JavaScriptSerializer().Serialize(new {
        version = 1, scope = "TRUSTED_VALIDATION_JOB_NOT_SANDBOX", resultExitCode = code,
        primaryExitCode = capture.PrimaryExitCode, timedOut = capture.TimedOut,
        jobAttested = capture.JobAttested, targetStarted = capture.Started,
        jobEmptyVerified = capture.JobEmptyVerified, pipesDrained = capture.Drained,
        residualOwnedProcesses = capture.JobEmptyVerified ? (int?)0 : null,
        childPid = capture.ChildPid, childGeneration = capture.ChildGeneration,
        stdoutBase64 = Convert.ToBase64String(capture.Output.ToArray()),
        stderrBase64 = Convert.ToBase64String(capture.Error.ToArray())
      }));
      return code;
    }
    // Minimal real Windows lock controls, never called from production tools.
    // Hold only the caller's newly-created validation fixture, then release.
    static int ValidationLock(string kind, string root) {
      IntPtr handle = IntPtr.Zero;
      string phase = "ROOT_VALIDATION";
      try {
        string full = Path.GetFullPath(root), parent = Path.GetDirectoryName(full);
        if (!String.Equals(parent, Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(full).StartsWith("phi-clone-cleanup-", StringComparison.Ordinal) ||
            (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0 ||
            (kind != "file" && kind != "directory" && kind != "inherited-directory")) throw new InvalidDataException();
        phase = "PIN_ROOT";
        using (RecoveryFilesystem pins = new RecoveryFilesystem(full)) {
          string target = kind == "file" ? Path.Combine(full, "locked.txt") : full;
          SecurityAttributes attributes = new SecurityAttributes(); attributes.Size = Marshal.SizeOf(typeof(SecurityAttributes));
          attributes.Inherit = kind == "inherited-directory" ? 1 : 0;
          phase = "OPEN_LOCK";
          // Attribute-only opens did not block DeleteFile/RemoveDirectory on
          // the native runner. READ_DATA/LIST_DIRECTORY is the required real
          // sharing-denial control, not an assumed lock from share flags alone.
          handle = ValidationCreateFile(target, 0x81, 3, ref attributes, 3, 0x02200000, IntPtr.Zero);
          if (handle == new IntPtr(-1)) { handle = IntPtr.Zero; throw new Win32Exception(Marshal.GetLastWin32Error()); }
        }
        if (kind == "inherited-directory") {
          phase = "INHERITED_CHILD";
          ProcessInfo descendant = new ProcessInfo();
          try {
            string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
            StartupEx start = new StartupEx(); start.Startup.Size = Marshal.SizeOf(typeof(Startup));
            start.Startup.Flags = 0x100; start.Startup.Input = GetStdHandle(-10);
            start.Startup.Output = GetStdHandle(-11); start.Startup.Error = GetStdHandle(-12);
            Check(CreateProcessW(self, new StringBuilder(Quote(self) + " --validation-inherited-lock " + handle.ToInt64() + " " + Quote(full)),
              IntPtr.Zero, IntPtr.Zero, true, NoWindow, IntPtr.Zero, parent, ref start, out descendant));
            Close(ref handle); // only the actual inherited child handle now locks the root
            if (WaitForSingleObject(descendant.Process, 5000) != 0) return 70;
            uint code; Check(GetExitCodeProcess(descendant.Process, out code)); if (code != 0) return 70;
          } finally { Close(ref descendant.Thread); Close(ref descendant.Process); }
        } else { phase = "DENIAL_CONTROL"; ValidationDenial(full, kind == "file", false); Thread.Sleep(1200); }
        return 0;
      } catch (Win32Exception error) { Console.Error.WriteLine("PHI_VALIDATION_LOCK:" + phase + ":" + error.NativeErrorCode); return 70; }
        catch { Console.Error.WriteLine("PHI_VALIDATION_LOCK:" + phase + ":0"); return 70; }
      finally { Close(ref handle); }
    }
    [DllImport("kernel32.dll", EntryPoint="CreateFileW", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr ValidationCreateFile(string path, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", EntryPoint="DeleteFileW", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ValidationDeleteFile(string path);
    [DllImport("kernel32.dll", EntryPoint="RemoveDirectoryW", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ValidationRemoveDirectory(string path);
    static void ValidationDenial(string root, bool file, bool inherited) {
      bool removed = file ? ValidationDeleteFile(Path.Combine(root, "locked.txt")) : ValidationRemoveDirectory(root);
      int nativeError = Marshal.GetLastWin32Error();
      if (removed || (nativeError != 32 && nativeError != 5)) { Console.Error.WriteLine("PHI_VALIDATION_LOCK:DENIAL_RESULT:" + nativeError); throw new InvalidDataException(); }
      File.WriteAllText(Path.Combine(root, "ready"), new JavaScriptSerializer().Serialize(new {
        operation = file ? "DELETE_FILE" : "REMOVE_DIRECTORY", nativeError,
        inheritedHandle = inherited, currentCwdInside = String.Equals(Environment.CurrentDirectory, root, StringComparison.OrdinalIgnoreCase)
      }));
    }
    internal static int Execute(Stream input, AppContainerScope scope, Capture capture = null, bool validation = false) {
      IntPtr job = IntPtr.Zero, list = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
      IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
      IntPtr guardian = IntPtr.Zero;
      IntPtr outputRead = IntPtr.Zero, errorRead = IntPtr.Zero;
      Thread outputThread = null, errorThread = null;
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
        bool suite = validation && scope == null && String.Equals(Path.GetFileName(command), "node.exe", StringComparison.OrdinalIgnoreCase) &&
          arguments.Count == 2 && String.Equals(StringValue(arguments[0]), Path.Combine(cwd, "scripts", "phi-check.mjs"), StringComparison.OrdinalIgnoreCase) &&
          StringValue(arguments[1]) == "--owned-validation";
        if (timeout < 1 || timeout > (suite ? 600000 : MaxLifetime)) throw new InvalidDataException();
        if (validation && scope == null && capture != null && timeout == MaxLifetime &&
            String.Equals(command, Path.Combine(Path.GetDirectoryName(command), "node.exe"), StringComparison.OrdinalIgnoreCase) &&
            arguments.Count == 9 && String.Equals(StringValue(arguments[0]), Path.Combine(Path.GetDirectoryName(command), "node_modules", "npm", "bin", "npm-cli.js"), StringComparison.OrdinalIgnoreCase) &&
            String.Join("\n", arguments.Cast<object>().Skip(1).Select(StringValue)) == "ci\n--prefix\nruntime/lsp\n--ignore-scripts\n--no-audit\n--no-fund\n--loglevel=silly\n--logs-max=0") {
          capture.Install = new InstallObservation(); capture.Install.Phase("REQUEST_VALIDATED");
        }
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
        if (capture == null) {
          Check(DuplicateHandle(self, GetStdHandle(-11), self, out output, 0, true, 2));
          Check(DuplicateHandle(self, GetStdHandle(-12), self, out error, 0, true, 2));
        } else {
          Check(CreatePipe(out outputRead, out output, ref security, 0));
          Check(SetHandleInformation(outputRead, 1, 0));
          Check(CreatePipe(out errorRead, out error, ref security, 0));
          Check(SetHandleInformation(errorRead, 1, 0));
          outputThread = capture.Drain(outputRead, capture.Output); outputRead = IntPtr.Zero;
          errorThread = capture.Drain(errorRead, capture.Error); errorRead = IntPtr.Zero;
        }
        phase = "ATTRIBUTES";
        IntPtr size = IntPtr.Zero;
        int attributeCount = scope == null ? 2 : scope.AttributeCount;
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
        if (capture != null && capture.Install != null) capture.Install.Phase("CREATE_START");
        Check(CreateProcessW(command, encoded, IntPtr.Zero, IntPtr.Zero, true, ExtendedStartup | UnicodeEnvironment | Suspended | NoWindow, environment, cwd, ref startup, out child));
        phase = "ATTEST";
        bool inside; Check(IsProcessInJob(child.Process, job, out inside)); if (!inside) throw new InvalidDataException();
        if (scope != null) scope.VerifyToken(child.Process);
        if (capture != null) capture.JobAttested = true;
        if (capture != null) {
          FileTime created, a, b, c; Check(GetProcessTimes(child.Process, out created, out a, out b, out c));
          capture.ChildPid = child.ProcessId; capture.ChildGeneration = created.Value.ToString();
        }
        Close(ref inputRead); Close(ref output); Close(ref error);
        SafeFileHandle writeHandle = new SafeFileHandle(inputWrite, true); inputWrite = IntPtr.Zero;
        Thread copy = new Thread(delegate() {
          try {
            using (FileStream pipe = new FileStream(writeHandle, FileAccess.Write)) {
              if (capture != null && capture.OnStarted != null) {
                // Interactive LSP requests must reach the server before the
                // next blocking read; FileStream's buffered CopyTo deadlocks.
                byte[] frame = new byte[8192]; int frameLength;
                while ((frameLength = input.Read(frame, 0, frame.Length)) != 0) { pipe.Write(frame, 0, frameLength); pipe.Flush(); }
              } else input.CopyTo(pipe);
            }
          }
          catch (IOException) { } catch (ObjectDisposedException) { } catch (ArgumentException) { }
          finally { writeHandle.Dispose(); }
        }); copy.IsBackground = true; copy.Start();
        phase = "RESUME";
        if (ResumeThread(child.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (capture != null) capture.Started = true;
        if (capture != null && capture.OnStarted != null) capture.OnStarted();
        if (capture != null && capture.Install != null) { capture.Install.Phase("TARGET_RESUMED"); capture.Install.Start(job); }
        IntPtr[] waitHandles = capture == null ? new IntPtr[] { child.Process, guardian } : new IntPtr[] { child.Process, guardian, capture.Overflow.SafeWaitHandle.DangerousGetHandle() };
        uint waited = WaitForMultipleObjects((uint)waitHandles.Length, waitHandles, false, (uint)timeout);
        if (capture != null && capture.Install != null) { capture.Install.Phase(waited == 258 ? "TARGET_DEADLINE" : "TARGET_WAIT_END"); capture.Install.Stop(); capture.Install.Snapshot(job, "BEFORE_TERMINATION"); }
        if (capture != null && waited == 2) throw new InvalidDataException();
        if (waited != 0 && waited != 1 && waited != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint code = waited == 1 ? 125U : 124U;
        if (waited == 0) Check(GetExitCodeProcess(child.Process, out code));
        if (capture != null) { capture.PrimaryExitCode = code <= 255 ? (int)code : 1; capture.TimedOut = waited == 258; }
        // A successful parent exit is not evidence that descendants finished.
        phase = "CLEANUP";
        if (capture != null && capture.Install != null) capture.Install.Phase("JOB_TERMINATION_START");
        Check(TerminateJobObject(job, 137));
        Stopwatch deadline = Stopwatch.StartNew();
        while (!EmptyJob(job)) { if (deadline.ElapsedMilliseconds >= 5000) throw new InvalidDataException(); Thread.Sleep(10); }
        if (capture != null) capture.JobEmptyVerified = true;
        if (capture != null && capture.Install != null) { capture.Install.Phase("JOB_EMPTY"); capture.Install.Snapshot(job, "AFTER_TERMINATION"); }
        writeHandle.Dispose();
        if (capture != null) {
          if (!outputThread.Join(5000) || !errorThread.Join(5000) || capture.Overflow.WaitOne(0)) throw new InvalidDataException();
          capture.Drained = true;
          if (capture.Install != null) capture.Install.Phase("PIPES_DRAINED");
        }
        return code <= 255 ? (int)code : 1;
      } catch (Win32Exception ex) { Console.Error.WriteLine("PHI_NATIVE_PROCESS_FAILED:" + ex.NativeErrorCode + ":" + phase); return 70; }
        catch { Console.Error.WriteLine("PHI_NATIVE_PROCESS_INVALID_OR_CLEANUP_FAILED:" + phase); return 70; }
      finally {
        if (capture != null && capture.Install != null) capture.Install.Stop();
        // On pre-resume attestation failure, closing a Job initiates asynchronous
        // termination. Drain it before the outer scope deletes profile/state.
        if (job != IntPtr.Zero) {
          try {
            Check(TerminateJobObject(job, 137)); Stopwatch end = Stopwatch.StartNew();
            while (!EmptyJob(job) && end.ElapsedMilliseconds < 5000) Thread.Sleep(10);
            if (capture != null) capture.JobEmptyVerified = EmptyJob(job);
          } catch { Console.Error.WriteLine("PHI_NATIVE_PROCESS_CLEANUP_UNATTESTED"); }
        }
        // Closing the non-inherited last Job handle kills owned children even on exception.
        Close(ref job); Close(ref child.Thread); Close(ref child.Process); Close(ref guardian);
        Close(ref inputRead); Close(ref inputWrite); Close(ref output); Close(ref error);
        Close(ref outputRead); Close(ref errorRead);
        if (capture != null && !capture.Drained) {
          capture.Drained = (outputThread == null || outputThread.Join(5000)) && (errorThread == null || errorThread.Join(5000));
        }
        if (listReady) DeleteProcThreadAttributeList(list);
        foreach (IntPtr pointer in new IntPtr[] { list, jobs, handles, environment }) if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
      }
    }
  }
}
