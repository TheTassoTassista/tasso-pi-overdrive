// Single-file native transaction primitive for the existing publication adapter.
// NOT a model tool, publication authority, or PUBLISHED/recovery certificate.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Phi.Native {
  internal static class AtomicModify {
    [StructLayout(LayoutKind.Sequential)] struct Disposition { public byte Delete; }
    [DllImport("ktmw32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateTransaction(IntPtr attributes, IntPtr uow, uint options, uint isolation, uint flags, uint timeout, string description);
    [DllImport("ktmw32.dll", SetLastError=true)] static extern bool CommitTransaction(IntPtr transaction);
    [DllImport("ktmw32.dll", SetLastError=true)] static extern bool RollbackTransaction(IntPtr transaction);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileTransactedW(string name, uint access, uint sharing, IntPtr attributes, uint disposition, uint flags, IntPtr template, IntPtr transaction, IntPtr miniversion, IntPtr extended);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(IntPtr directory, StringBuilder name, uint nameSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder filesystem, uint filesystemSize);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file, out RecoveryFilesystem.Info info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(IntPtr file, long distance, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file, byte[] data, uint size, out uint count, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr file, byte[] data, uint size, out uint count, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEndOfFile(IntPtr file);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr file);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr file, int type, ref Disposition value, uint size);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle, uint type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    const int MaxBytes = 1024 * 1024;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 16 }; }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero; }
    static string Hash(byte[] bytes) { using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static RecoveryFilesystem.Info Validate(IntPtr handle) {
      RecoveryFilesystem.Info info; Check(GetFileInformationByHandle(handle, out info));
      if ((info.Attributes & (1 | 0x10 | 0x400)) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > MaxBytes) throw new InvalidDataException(); return info;
    }
    static string SecurityDigest(IntPtr handle) {
      IntPtr owner, group, dacl, sacl, descriptor;
      uint status = GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor);
      if (status != 0) throw new Win32Exception((int)status);
      try { uint size = GetSecurityDescriptorLength(descriptor); if (size < 20 || size > 65536) throw new InvalidDataException(); byte[] bytes = new byte[size]; Marshal.Copy(descriptor, bytes, 0, bytes.Length); return Hash(bytes); }
      finally { LocalFree(descriptor); }
    }
    static void Rewind(IntPtr file) { long offset; Check(SetFilePointerEx(file, 0, out offset, 0)); if (offset != 0) throw new InvalidDataException(); }
    static byte[] Read(IntPtr file) {
      Validate(file); Rewind(file);
      using (MemoryStream data = new MemoryStream()) { byte[] block = new byte[4096]; uint count;
        do { Check(ReadFile(file, block, (uint)block.Length, out count, IntPtr.Zero)); if (count > block.Length || data.Length + count > MaxBytes) throw new InvalidDataException(); data.Write(block, 0, (int)count); } while (count != 0);
        return data.ToArray();
      }
    }
    static void WriteComplete(IntPtr file, byte[] bytes) {
      if (bytes == null || bytes.Length > MaxBytes) throw new InvalidDataException(); Rewind(file); uint count;
      Check(WriteFile(file, bytes, (uint)bytes.Length, out count, IntPtr.Zero)); if (count != bytes.Length) throw new InvalidDataException(); Check(SetEndOfFile(file));
    }
    static IntPtr OpenTransacted(string path, IntPtr transaction, bool create) {
      // No sharing, no reparse following, never OPEN_ALWAYS/overwrite. Only the
      // transaction-bound target stream is written; no ordinary target writer.
      IntPtr handle = CreateFileTransactedW(path, 0xc0100000U | (create ? 0x10000U : 0U), 0, IntPtr.Zero, create ? 1U : 3U, 0x200080, IntPtr.Zero, transaction, IntPtr.Zero, IntPtr.Zero);
      if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try { Validate(handle); return handle; } catch { CloseHandle(handle); throw; }
    }
    internal static object ReplaceDefaultStream(string root, string rootId, string relative, string expectedId, string expectedDigest, byte[] bytes, Action<string, string> checkpoint) {
      string[] parts = AnchoredFile.Segments(relative);
      if (bytes == null || bytes.Length > MaxBytes || Utf8.GetString(bytes).IndexOf('\0') >= 0) throw new InvalidDataException();
      string expectedNew = Hash(bytes); if (expectedNew == expectedDigest) throw new InvalidDataException();
      IntPtr transaction = IntPtr.Zero, temp = IntPtr.Zero, target = IntPtr.Zero;
      bool committed = false; string tempId = null, security = null, stage = "ADMISSION";
      try {
        using (RecoveryFilesystem rootPins = new RecoveryFilesystem(root)) {
          if (RecoveryFilesystem.DirectoryIdentity(root) != rootId) throw new InvalidDataException();
          string targetPath = parts.Aggregate(root, (current, part) => Path.Combine(current, part));
          using (RecoveryFilesystem parent = new RecoveryFilesystem(Path.GetDirectoryName(targetPath))) {
            uint serial, length, flags; StringBuilder filesystem = new StringBuilder(32);
            Check(GetVolumeInformationByHandleW(parent.DirectoryHandle, null, 0, out serial, out length, out flags, filesystem, 32));
            if (filesystem.ToString() != "NTFS" || (flags & 0x200000) == 0) {
              Console.Error.WriteLine("PHI_ATOMIC_MODIFY_VOLUME:" + Json().Serialize(new { ntfs = filesystem.ToString() == "NTFS", transactionsAdvertised = (flags & 0x200000) != 0 }));
              throw new InvalidOperationException("PHI_ATOMIC_MODIFY_VOLUME_UNSUPPORTED");
            }
            checkpoint("before-transaction", null);
            // Finite, non-distributed transaction; no system configuration,
            // DTC, ACL grant, filesystem driver, or unsafe API fallback.
            transaction = CreateTransaction(IntPtr.Zero, IntPtr.Zero, 1, 0, 0, 30000, "Phi single-file publication");
            if (transaction == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            stage = "TEMP_CREATE";
            temp = OpenTransacted(Path.Combine(Path.GetDirectoryName(targetPath), "phi-publish-" + Guid.NewGuid().ToString("N") + ".tmp"), transaction, true);
            tempId = RecoveryFilesystem.HandleIdentity(temp); checkpoint("temp", tempId);
            stage = "TEMP_WRITE"; WriteComplete(temp, bytes); checkpoint("write", tempId);
            stage = "TEMP_FLUSH"; Check(FlushFileBuffers(temp)); checkpoint("flush", tempId);
            stage = "TEMP_VALIDATE";
            if (RecoveryFilesystem.HandleIdentity(temp) != tempId || Hash(Read(temp)) != expectedNew || tempId.Substring(0, 16) != rootId.Substring(0, 16)) throw new InvalidDataException();
            checkpoint("validation", tempId);
            stage = "DESTINATION_LOCK";
            target = OpenTransacted(targetPath, transaction, false);
            RecoveryFilesystem.Info original = Validate(target);
            if (RecoveryFilesystem.HandleIdentity(target) != expectedId || Hash(Read(target)) != expectedDigest) throw new InvalidOperationException("PHI_ATOMIC_MODIFY_CONFLICT");
            security = SecurityDigest(target); checkpoint("locked", tempId);
            // The transacted writer locks this exact object. Staged/truncated
            // bytes are private to the transaction, not a direct/in-place host
            // fallback. Only synchronous KTM commit exposes the whole version.
            stage = "STAGED_WRITE"; WriteComplete(target, Read(temp)); Check(FlushFileBuffers(target));
            if (RecoveryFilesystem.HandleIdentity(target) != expectedId || Hash(Read(target)) != expectedNew || SecurityDigest(target) != security) throw new InvalidDataException();
            Disposition remove = new Disposition { Delete = 1 };
            Check(SetFileInformationByHandle(temp, 4, ref remove, (uint)Marshal.SizeOf(typeof(Disposition))));
            Close(ref temp); Close(ref target);
            // Transactional object locking survives closing the file handles;
            // no name check/reopen/overwrite window is introduced here.
            checkpoint("before-commit", tempId); stage = "KTM_COMMIT";
            Check(CommitTransaction(transaction)); committed = true; checkpoint("committed", tempId);
            stage = "POSTVERIFY";
            RecoveryFilesystem.Info final; target = parent.OpenPublicationReadFile(parts[parts.Length - 1], out final);
            if (RecoveryFilesystem.HandleIdentity(target) != expectedId || Hash(Read(target)) != expectedNew || SecurityDigest(target) != security ||
                final.Attributes != original.Attributes || final.Created.Low != original.Created.Low || final.Created.High != original.Created.High) throw new InvalidDataException();
            checkpoint("postverify", tempId);
            return new { backend = "NTFS_KTM_TRANSACTIONAL_DEFAULT_STREAM", committed = true, rootIdentity = rootId, destinationIdentity = expectedId,
              oldDigest = expectedDigest, tempIdentity = tempId, tempDigest = expectedNew, finalDigest = expectedNew,
              sameVolume = true, securityPreserved = true, creationTimePreserved = true, temporaryObjectInPrivateTransaction = true };
          }
        }
      } catch (Exception error) {
        Console.Error.WriteLine("PHI_ATOMIC_MODIFY_FAILURE:" + stage + ":" + unchecked((uint)Marshal.GetHRForException(error)).ToString("x8"));
        Win32Exception native = error as Win32Exception;
        if (native != null) Console.Error.WriteLine("PHI_ATOMIC_MODIFY_NATIVE_ERROR:" + native.NativeErrorCode);
        throw;
      } finally {
        Close(ref temp); Close(ref target);
        if (!committed && transaction != IntPtr.Zero && transaction != new IntPtr(-1)) {
          // Failure here is never hidden as a successful transaction. The
          // journal/controller adapter must retain uncertain commit evidence.
          if (!RollbackTransaction(transaction)) Console.Error.WriteLine("PHI_ATOMIC_MODIFY_ROLLBACK_UNCONFIRMED:" + Marshal.GetLastWin32Error());
        }
        Close(ref transaction);
      }
    }
    internal static int SelfTest(string name) {
      string[] cases = { "commit", "old-visible-before-commit", "locked-after-handles-close", "changed-content", "same-content-recreated", "write", "flush", "before-commit", "committed" };
      if (!cases.Contains(name)) return 70;
      ScopeRecovery scope = null; bool passed = false, cleanup = false, injected = false, committed = false, locked = false, oldVisible = false, outsideWritePositive = false; object evidence = null;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        string destination = Path.Combine(scope.Root, "input.txt"); File.WriteAllText(destination, "old-complete", Utf8);
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root), id, digest;
        using (AnchoredFile baseline = new AnchoredFile(scope.Root, rootId, "input.txt")) { id = baseline.Identity; digest = baseline.Digest; }
        if (name == "changed-content") File.WriteAllText(destination, "user-complete", Utf8);
        if (name == "same-content-recreated") { File.Move(destination, destination + ".old"); File.WriteAllText(destination, "old-complete", Utf8); }
        bool conflict = false;
        try {
          evidence = ReplaceDefaultStream(scope.Root, rootId, "input.txt", id, digest, Utf8.GetBytes("new-complete"), delegate(string phase, string tempId) {
            if (phase == "committed") committed = true;
            if (phase == "before-transaction" && name == "locked-after-handles-close") {
              // Same pinned parents and same ordinary API before KTM locking.
              // Later denial must not be attributed to an unrelated host ACL.
              File.WriteAllText(destination, "old-complete", Utf8);
              if (File.ReadAllText(destination) != "old-complete") throw new InvalidDataException(); outsideWritePositive = true;
            }
            if (phase == "before-commit" && (name == "old-visible-before-commit" || name == "locked-after-handles-close")) {
              if (File.ReadAllText(destination) != "old-complete") throw new InvalidDataException(); oldVisible = true;
              if (name == "locked-after-handles-close") {
                try { File.WriteAllText(destination, "user-must-not-overwrite", Utf8); }
                catch (IOException error) { int code = error.HResult & 0xffff; if (code != 32 && code != 6800) throw; locked = true; }
                if (!locked || File.ReadAllText(destination) != "old-complete") throw new InvalidDataException();
              }
            }
            if (phase == name) { injected = true; throw new IOException("PHI_ATOMIC_MODIFY_INJECTED"); }
          });
        } catch (InvalidOperationException error) { if (error.Message != "PHI_ATOMIC_MODIFY_CONFLICT") throw; conflict = true; }
          catch (IOException) { if (!injected) throw; }
        bool expectedConflict = name == "changed-content" || name == "same-content-recreated";
        string expected = name == "changed-content" ? "user-complete" : expectedConflict || (injected && !committed) ? "old-complete" : "new-complete";
        if (conflict != expectedConflict || File.ReadAllText(destination) != expected ||
            injected != new string[] { "write", "flush", "before-commit", "committed" }.Contains(name) ||
            (name == "old-visible-before-commit" || name == "locked-after-handles-close") && !oldVisible || name == "locked-after-handles-close" && (!locked || !outsideWritePositive)) throw new InvalidDataException();
        passed = true;
      } catch { Console.Error.WriteLine("PHI_ATOMIC_MODIFY_SELFTEST_FAILED"); }
      finally { if (scope != null) { try { scope.CleanupFiles(); cleanup = !Directory.Exists(scope.Root); } catch { passed = false; } scope.Complete(cleanup); } }
      Console.WriteLine(Json().Serialize(new { caseName = name, passed, fixtureCleanup = cleanup, injected, committed, lockedAfterHandlesClose = locked, outsideWritePositive, oldVisibleBeforeCommit = oldVisible,
        evidence, scope = "NATIVE_TRANSACTION_PRIMITIVE_NOT_PRODUCTION_PUBLICATION", projectPublished = false, externalRequests = 0 }));
      return passed && cleanup ? 0 : 70;
    }
  }
}
