// Controller recovery only; not yet a generic ResourceFS/EditEngine backend.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace Phi.Native {
  internal sealed class RecoveryFilesystem : IDisposable {
    [StructLayout(LayoutKind.Sequential)] internal struct Time { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] internal struct Info {
      public uint Attributes; public Time Created, Accessed, Written;
      public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct Identity { public ulong Volume, Low, High; }
    [StructLayout(LayoutKind.Sequential)] struct Disposition { public byte Delete; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file, out Info info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr file, int type, out Identity info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr file, int type, ref Disposition info, uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
    readonly List<IntPtr> parents = new List<IntPtr>();
    internal static void LogFailure(Exception error) {
      Win32Exception native = error as Win32Exception;
      string code = native == null ? "OBJECT_REJECTED" : native.NativeErrorCode == 32 || native.NativeErrorCode == 33 ? "SHARING_VIOLATION" : native.NativeErrorCode == 5 ? "ACCESS_DENIED" : native.NativeErrorCode == 145 ? "DIRECTORY_NOT_EMPTY" : "NATIVE_OTHER";
      Console.Error.WriteLine("PHI_FILESYSTEM_" + code);
    }
    internal RecoveryFilesystem(string directory) {
      string full = Path.GetFullPath(directory), drive = Path.GetPathRoot(full);
      if (drive.Length != 3 || drive[1] != ':' || full.StartsWith("\\\\")) throw new InvalidDataException();
      try {
        string current = drive;
        PinParent(current);
        foreach (string part in full.Substring(drive.Length).Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
          if (part == "." || part == ".." || part.IndexOf(':') >= 0) throw new InvalidDataException();
          current = Path.Combine(current, part); PinParent(current);
        }
      } catch { Dispose(); throw; }
    }
    static IntPtr Open(string file, bool delete, out Info info) {
      // No FILE_SHARE_DELETE: once opened, this actual object cannot be renamed
      // out from under path-based enumeration. Final reparse is opened, not followed.
      IntPtr handle = CreateFileW(file, 0x80U | (delete ? 0x10000U : 0U), 1, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero);
      if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!GetFileInformationByHandle(handle, out info)) { int error = Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(error); }
      return handle;
    }
    void PinParent(string directory) {
      Info info; IntPtr handle = Open(directory, false, out info);
      if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0) { CloseHandle(handle); throw new InvalidDataException(); }
      parents.Add(handle);
    }
    internal static string HandleIdentity(IntPtr handle) {
      Identity identity;
      if (!GetFileInformationByHandleEx(handle, 18, out identity, (uint)Marshal.SizeOf(typeof(Identity)))) throw new Win32Exception(Marshal.GetLastWin32Error());
      return identity.Volume.ToString("x16") + ":" + identity.Low.ToString("x16") + identity.High.ToString("x16");
    }
    internal static string DirectoryIdentity(string directory) {
      Info info; IntPtr handle = Open(directory, false, out info);
      try {
        if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0) throw new InvalidDataException();
        return HandleIdentity(handle);
      } finally { CloseHandle(handle); }
    }
    internal static IntPtr OpenExclusiveFile(string file, out Info info) {
      IntPtr handle = CreateFileW(file, 0xc0000000U, 0, IntPtr.Zero, 3, 0x200000, IntPtr.Zero);
      if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!GetFileInformationByHandle(handle, out info)) { int error = Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(error); }
      return handle;
    }
    internal static void WithDirectoryAuthority(string directory, string expectedIdentity, Action<IntPtr> operation) {
      using (RecoveryFilesystem pins = new RecoveryFilesystem(directory)) {
        IntPtr handle = CreateFileW(directory, 0xc0080, 3, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
          Info info;
          if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
          if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0 || HandleIdentity(handle) != expectedIdentity) throw new InvalidDataException();
          operation(handle);
          if (HandleIdentity(handle) != expectedIdentity) throw new InvalidDataException();
        } finally { CloseHandle(handle); }
      }
    }
    internal void DeleteOwnedTree(string root, string expected) {
      Info info; IntPtr handle;
      try { handle = Open(root, true, out info); }
      catch (Win32Exception ex) { if (ex.NativeErrorCode == 2 || ex.NativeErrorCode == 3) return; throw; }
      try {
        if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0 || HandleIdentity(handle) != expected) throw new InvalidDataException();
        int remaining = 2048; DateTime deadline = DateTime.UtcNow.AddSeconds(5);
        DeleteContents(root, 0, ref remaining, deadline);
        DeleteHandle(handle);
      } finally { CloseHandle(handle); }
    }
    static void DeleteContents(string directory, int depth, ref int remaining, DateTime deadline) {
      if (depth > 16) throw new InvalidDataException();
      foreach (string entry in Directory.EnumerateFileSystemEntries(directory)) {
        if (--remaining < 0 || DateTime.UtcNow >= deadline) throw new InvalidDataException();
        Info info; IntPtr handle = Open(entry, true, out info);
        try {
          // All intermediate parents remain pinned. Never recurse through a
          // reparse point; disposing the opened entry unlinks only that alias.
          if ((info.Attributes & 0x10) != 0 && (info.Attributes & 0x400) == 0) DeleteContents(entry, depth + 1, ref remaining, deadline);
          DeleteHandle(handle);
        } finally { CloseHandle(handle); }
      }
    }
    static void DeleteHandle(IntPtr handle) {
      Disposition value = new Disposition(); value.Delete = 1;
      if (!SetFileInformationByHandle(handle, 4, ref value, (uint)Marshal.SizeOf(typeof(Disposition)))) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public void Dispose() { for (int index = parents.Count - 1; index >= 0; index--) CloseHandle(parents[index]); parents.Clear(); }
  }
}
