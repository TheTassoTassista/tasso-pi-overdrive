// Controller recovery only; not yet a generic ResourceFS/EditEngine backend.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using System.Text.RegularExpressions;

namespace Phi.Native {
  internal sealed class RecoveryFilesystem : IDisposable {
    [StructLayout(LayoutKind.Sequential)] internal struct Time { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] internal struct Info {
      public uint Attributes; public Time Created, Accessed, Written;
      public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct Identity { public ulong Volume, Low, High; }
    [StructLayout(LayoutKind.Sequential)] struct Disposition { public byte Delete; }
    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public uint Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Descriptor, Quality; }
    [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
    [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr file, uint access, ref ObjectAttributes attributes, out IoStatus status, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
    [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file, out Info info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr file, int type, out Identity info, uint size);
    [DllImport("kernel32.dll", EntryPoint="GetFileInformationByHandleEx", SetLastError=true)] static extern bool QueryDirectory(IntPtr file, int type, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr file, int type, ref Disposition info, uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
    readonly List<IntPtr> parents = new List<IntPtr>();
    readonly string directoryPath;
    internal static volatile int TransientDeleteRetries;
    internal static volatile int TransientOpenRetries;
    static void Failure(string operation, IntPtr parent, string name, uint access, uint share, uint options, int status, int error) {
      // Fixed operation names plus numeric/object metadata only. Never emit a
      // DOS path, leaf name, ACL text, environment, exception or file contents.
      string identity = "unavailable";
      try { if (parent != IntPtr.Zero) identity = HandleIdentity(parent); } catch { }
      string digest = "";
      if (name != null) using (SHA256 hash = SHA256.Create()) digest = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(name))).Replace("-", "").ToLowerInvariant();
      Console.Error.WriteLine("PHI_FILESYSTEM_FAILURE:" + new JavaScriptSerializer().Serialize(new {
        operation, access = access.ToString("x8"), share, options = options.ToString("x8"),
        nativeStatus = unchecked((uint)status).ToString("x8"), nativeError = error,
        objectIdentity = identity, leafDigest = digest
      }));
    }
    internal static void LogFailure(Exception error) {
      Win32Exception native = error as Win32Exception;
      string code = native == null ? "OBJECT_REJECTED" : native.NativeErrorCode == 32 || native.NativeErrorCode == 33 ? "SHARING_VIOLATION" : native.NativeErrorCode == 5 ? "ACCESS_DENIED" : native.NativeErrorCode == 145 ? "DIRECTORY_NOT_EMPTY" : "NATIVE_OTHER";
      Console.Error.WriteLine("PHI_FILESYSTEM_" + code);
      if (native != null && native.NativeErrorCode >= 0 && native.NativeErrorCode <= 65535) Console.Error.WriteLine("PHI_FILESYSTEM_NATIVE_ERROR:" + native.NativeErrorCode);
    }
    internal RecoveryFilesystem(string directory) {
      string full = Path.GetFullPath(directory), drive = Path.GetPathRoot(full);
      directoryPath = full;
      if (drive.Length != 3 || drive[1] != ':' || full.StartsWith("\\\\")) throw new InvalidDataException();
      try {
        string current = drive;
        PinParent(current);
        foreach (string part in full.Substring(drive.Length).Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
          if (part == "." || part == ".." || part.IndexOf(':') >= 0) throw new InvalidDataException();
          current = Path.Combine(current, part); PinRelativeParent(part);
        }
      } catch { Dispose(); throw; }
    }
    static IntPtr Open(string file, bool delete, out Info info) {
      // No FILE_SHARE_DELETE: once opened, this actual object cannot be renamed
      // out from under path-based enumeration. Final reparse is opened, not followed.
      IntPtr handle = CreateFileW(file, 0x80U | (delete ? 0x10000U : 0U), 1, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero);
      if (handle == new IntPtr(-1)) { int error = Marshal.GetLastWin32Error(); Failure("ROOT_OPEN", IntPtr.Zero, null, 0x80U | (delete ? 0x10000U : 0U), 1, 0x2200000, 0, error); throw new Win32Exception(error); }
      if (!GetFileInformationByHandle(handle, out info)) { int error = Marshal.GetLastWin32Error(); CloseHandle(handle); throw new Win32Exception(error); }
      return handle;
    }
    void PinParent(string directory) {
      Info info; IntPtr handle = Open(directory, false, out info);
      if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0) { CloseHandle(handle); throw new InvalidDataException(); }
      parents.Add(handle);
    }
    static void Leaf(string name) {
      if (String.IsNullOrEmpty(name) || name.Length > 1024 || name == "." || name == ".." || name.IndexOfAny(new char[] { '\\', '/', ':', '\0' }) >= 0) throw new InvalidDataException();
    }
    static IntPtr OpenRelative(IntPtr parent, string name, uint access, uint share, uint disposition, uint options, IntPtr descriptor, out Info info, bool unlinkReparse = false, Stopwatch cleanupDeadline = null) {
      Leaf(name); Info parentInfo;
      if (!GetFileInformationByHandle(parent, out parentInfo)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if ((parentInfo.Attributes & 0x400) != 0 || (parentInfo.Attributes & 0x10) == 0) throw new InvalidDataException();
      IntPtr text = Marshal.StringToHGlobalUni(name), unicode = IntPtr.Zero, handle = IntPtr.Zero;
      try {
        UnicodeString value = new UnicodeString(); value.Length = checked((ushort)(name.Length * 2)); value.MaximumLength = checked((ushort)(value.Length + 2)); value.Buffer = text;
        unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString))); Marshal.StructureToPtr(value, unicode, false);
        ObjectAttributes attributes = new ObjectAttributes(); attributes.Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)); attributes.Root = parent; attributes.Name = unicode; attributes.Attributes = unlinkReparse ? 0x40U : 0x1040U; attributes.Descriptor = descriptor;
        IoStatus status;
        bool diagnosed = false;
        while (true) {
          int result = NtCreateFile(out handle, access | 0x100000, ref attributes, out status, IntPtr.Zero, 0, share, disposition, options | 0x200020, IntPtr.Zero, 0);
          if (result == 0) break;
          int error = (int)RtlNtStatusToDosError(result);
          // Cleanup lookup only, before any successful child open. The parent
          // stays pinned, names are single components and reparses never follow.
          // STATUS_DELETE_PENDING maps to Win32 5, unlike an ACL denial:
          // never retry STATUS_ACCESS_DENIED or broaden rights/sharing.
          bool transient = result == unchecked((int)0xc0000043) || result == unchecked((int)0xc0000056);
          if (!diagnosed || cleanupDeadline == null || !transient || cleanupDeadline.ElapsedMilliseconds >= 5000) Failure("NT_OPEN", parent, name, access | 0x100000, share, options | 0x200020, result, error);
          diagnosed = true;
          if (cleanupDeadline == null || !transient || cleanupDeadline.ElapsedMilliseconds >= 5000) throw new Win32Exception(error);
          if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
          handle = IntPtr.Zero;
          TransientOpenRetries++;
          System.Threading.Thread.Sleep(10);
        }
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        // Only owned-tree unlinking may open a final reparse point itself.
        // FILE_OPEN_REPARSE_POINT always applies; never follow its target.
        if (!unlinkReparse && (info.Attributes & 0x400) != 0) throw new InvalidDataException();
        return handle;
      } catch { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); throw; }
      finally { if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
    }
    void PinRelativeParent(string name) {
      Info info; IntPtr handle = OpenRelative(parents[parents.Count - 1], name, 0xa0, 1, 1, 1, IntPtr.Zero, out info);
      if ((info.Attributes & 0x10) == 0) { CloseHandle(handle); throw new InvalidDataException(); }
      parents.Add(handle);
    }
    internal IntPtr OpenFile(string leaf, out Info info) {
      return OpenRelative(parents[parents.Count - 1], leaf, 0x12019f, 0, 1, 0x40, IntPtr.Zero, out info);
    }
    internal IntPtr OpenReadFile(string leaf, out Info info) {
      // Broker runtime snapshot: read only, no write/delete sharing, no reparse.
      return OpenRelative(parents[parents.Count - 1], leaf, 0x81, 1, 1, 0x40, IntPtr.Zero, out info);
    }
    // Read-only controller extraction. Every component is opened from a held
    // directory; all source handles remain pinned until the snapshot completes.
    // No host grants, pathname reads, recursive copies or publication authority.
    internal object ReadProjectSnapshot() {
      var handles = new List<IntPtr>();
      var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
      var identities = new SortedDictionary<string, string>(StringComparer.Ordinal);
      int remaining = 2048, bytes = 0;
      Stopwatch deadline = Stopwatch.StartNew();
      try {
        Info info;
        IntPtr root = OpenRelative(parents[parents.Count - 2], Path.GetFileName(directoryPath), 0x81, 1, 1, 1, IntPtr.Zero, out info);
        handles.Add(root);
        if (HandleIdentity(root) != HandleIdentity(parents[parents.Count - 1])) throw new InvalidDataException();
        SnapshotDirectory(root, "", 0, handles, files, identities, ref remaining, ref bytes, deadline);
        return new { version = 1, rootIdentity = HandleIdentity(root), files, identities };
      } finally { for (int i = handles.Count - 1; i >= 0; i--) CloseHandle(handles[i]); }
    }
    static void SnapshotDirectory(IntPtr directory, string prefix, int depth, List<IntPtr> handles,
        SortedDictionary<string, string> files, SortedDictionary<string, string> identities,
        ref int remaining, ref int totalBytes, Stopwatch deadline) {
      if (depth > 12 || deadline.ElapsedMilliseconds >= 5000) throw new InvalidDataException();
      const int Size = 32768;
      IntPtr buffer = Marshal.AllocHGlobal(Size);
      var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      try {
        bool restart = true;
        while (true) {
          if (deadline.ElapsedMilliseconds >= 5000) throw new InvalidDataException();
          Marshal.Copy(new byte[Size], 0, buffer, Size);
          if (!QueryDirectory(directory, restart ? 15 : 14, buffer, Size)) {
            int error = Marshal.GetLastWin32Error(); if (error == 18) break;
            throw new Win32Exception(error);
          }
          restart = false;
          int offset = 0;
          while (true) {
            if (offset > Size - 68 || deadline.ElapsedMilliseconds >= 5000) throw new InvalidDataException();
            IntPtr entry = IntPtr.Add(buffer, offset);
            uint next = unchecked((uint)Marshal.ReadInt32(entry, 0)), length = unchecked((uint)Marshal.ReadInt32(entry, 60));
            if (length < 2 || (length & 1) != 0 || length > 2048 || length > Size - offset - 68 ||
                (next != 0 && (next < 68 + length || (next & 7) != 0 || next > Size - offset - 68))) throw new InvalidDataException();
            string name = Marshal.PtrToStringUni(IntPtr.Add(entry, 68), (int)length / 2);
            if (name != "." && name != "..") {
              if (--remaining < 0 || !names.Add(name)) throw new InvalidDataException();
              // Names only: protected entries are never opened/read.
              bool protectedName = Regex.IsMatch(name, "\\A(?:\\.git|node_modules|\\.phi-cache|\\.env(?:\\..*)?|\\.ssh|\\.aws|\\.gnupg|\\.password-store|browser-data|keyrings|auth\\.json|credentials(?:\\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)|known_hosts|netrc)\\z|\\.(?:pem|p12|pfx|key)\\z", RegexOptions.IgnoreCase);
              if (!protectedName) {
                if (!Regex.IsMatch(name, "\\A[A-Za-z0-9_.-]+\\z") || name.EndsWith(".") ||
                    Regex.IsMatch(name, "\\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|\\z)", RegexOptions.IgnoreCase)) throw new InvalidDataException();
                uint attributes = unchecked((uint)Marshal.ReadInt32(entry, 56));
                bool isDirectory = (attributes & 0x10) != 0;
                Info info;
                IntPtr child = OpenRelative(directory, name, 0x81, 1, 1, isDirectory ? 1U : 0x40U, IntPtr.Zero, out info);
                handles.Add(child);
                string relative = prefix + name;
                if ((info.Attributes & 0x400) != 0) throw new InvalidDataException();
                if (isDirectory) {
                  if ((info.Attributes & 0x10) == 0) throw new InvalidDataException();
                  SnapshotDirectory(child, relative + "/", depth + 1, handles, files, identities, ref remaining, ref totalBytes, deadline);
                } else {
                  if ((info.Attributes & 0x10) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 512 * 1024 || files.Count >= 256) throw new InvalidDataException();
                  byte[] value;
                  using (FileStream stream = new FileStream(new SafeFileHandle(child, false), FileAccess.Read))
                  using (MemoryStream data = new MemoryStream()) {
                    byte[] block = new byte[4096]; int count;
                    while ((count = stream.Read(block, 0, block.Length)) != 0) {
                      totalBytes += count; if (totalBytes > 512 * 1024 || deadline.ElapsedMilliseconds >= 5000) throw new InvalidDataException();
                      data.Write(block, 0, count);
                    }
                    value = data.ToArray();
                  }
                  string text = new UTF8Encoding(false, true).GetString(value);
                  if (text.IndexOf('\0') >= 0) throw new InvalidDataException();
                  files.Add(relative, text); identities.Add(relative, HandleIdentity(child));
                }
              }
            }
            if (next == 0) break;
            offset += (int)next;
          }
        }
      } finally { Marshal.FreeHGlobal(buffer); }
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
    internal static void WithDirectoryAuthority(string directory, string expectedIdentity, Action<IntPtr> operation) {
      using (RecoveryFilesystem pins = new RecoveryFilesystem(directory)) {
        IntPtr handle = CreateFileW(directory, 0xe0080, 3, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero);
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
    internal static void CreateDirectory(string directory, DirectorySecurity acl, bool allowExisting) {
      // Single-component native create while every existing parent is pinned.
      // No recursive path traversal or ACL rewrite of an existing object.
      using (RecoveryFilesystem pins = new RecoveryFilesystem(Path.GetDirectoryName(directory))) {
        byte[] bytes = acl.GetSecurityDescriptorBinaryForm(); IntPtr descriptor = Marshal.AllocHGlobal(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, descriptor, bytes.Length);
          pins.CreateChildDirectory(Path.GetFileName(directory), descriptor, allowExisting);
        } finally { Marshal.FreeHGlobal(descriptor); }
      }
    }
    void CreateChildDirectory(string name, IntPtr descriptor, bool allowExisting) {
      Info info; IntPtr child = OpenRelative(parents[parents.Count - 1], name, 0xa0, 1, allowExisting ? 3U : 2U, 1, descriptor, out info);
      try { if ((info.Attributes & 0x10) == 0) throw new InvalidDataException(); }
      finally { CloseHandle(child); }
    }
    internal void CreateChildDirectory(string name, DirectorySecurity acl) {
      byte[] bytes = acl.GetSecurityDescriptorBinaryForm(); IntPtr descriptor = Marshal.AllocHGlobal(bytes.Length);
      try { Marshal.Copy(bytes, 0, descriptor, bytes.Length); CreateChildDirectory(name, descriptor, false); }
      finally { Marshal.FreeHGlobal(descriptor); }
    }
    internal void DeleteOwnedTree(string root, string expected) {
      string full = Path.GetFullPath(root);
      if (!String.Equals(Path.GetDirectoryName(full), directoryPath, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
      Info info; IntPtr handle;
      Stopwatch deadline = Stopwatch.StartNew();
      try { handle = OpenRelative(parents[parents.Count - 1], Path.GetFileName(full), 0x10081, 1, 1, 1, IntPtr.Zero, out info, false, deadline); }
      catch (Win32Exception ex) { if (ex.NativeErrorCode == 2 || ex.NativeErrorCode == 3) return; throw; }
      try {
        if ((info.Attributes & 0x400) != 0 || (info.Attributes & 0x10) == 0 || HandleIdentity(handle) != expected) throw new InvalidDataException();
        int remaining = 2048;
        DeleteContents(handle, 0, ref remaining, deadline);
        DeleteHandle(handle, info, deadline);
      } finally { CloseHandle(handle); }
    }
    static void DeleteContents(IntPtr directory, int depth, ref int remaining, Stopwatch deadline) {
      if (depth > 16) throw new InvalidDataException();
      // FILE_FULL_DIR_INFO: name length at byte 60, UTF-16 name at byte 68.
      // Enumerate the actual pinned object, not a substituted DOS pathname.
      const int BufferSize = 32768;
      IntPtr buffer = Marshal.AllocHGlobal(BufferSize);
      try {
        bool restart = true;
        while (true) {
          if (deadline.ElapsedMilliseconds >= 5000) throw new InvalidDataException();
          Marshal.Copy(new byte[BufferSize], 0, buffer, BufferSize);
          if (!QueryDirectory(directory, restart ? 15 : 14, buffer, BufferSize)) {
            int error = Marshal.GetLastWin32Error();
            if (error == 18) break; // ERROR_NO_MORE_FILES only; no fallback.
            Failure("ENUMERATE", directory, null, 0x10081, 1, 1, 0, error);
            throw new Win32Exception(error);
          }
          restart = false;
          int offset = 0;
          while (true) {
            if (offset > BufferSize - 68 || deadline.ElapsedMilliseconds >= 5000) throw new InvalidDataException();
            IntPtr entry = IntPtr.Add(buffer, offset);
            uint next = unchecked((uint)Marshal.ReadInt32(entry, 0));
            uint bytes = unchecked((uint)Marshal.ReadInt32(entry, 60));
            if (bytes < 2 || (bytes & 1) != 0 || bytes > 2048 || bytes > BufferSize - offset - 68 || (next != 0 && (next < 68 + bytes || (next & 7) != 0 || next > BufferSize - offset - 68))) throw new InvalidDataException();
            string name = Marshal.PtrToStringUni(IntPtr.Add(entry, 68), (int)bytes / 2);
            if (name != "." && name != "..") {
              Leaf(name);
              if (--remaining < 0) throw new InvalidDataException();
              Info info;
              // Open just this enumerated leaf relative to the held parent.
              // No mutation of content/ACLs/attributes, even for hard links.
              uint attributes = unchecked((uint)Marshal.ReadInt32(entry, 56));
              bool isDirectory = (attributes & 0x10) != 0;
              // Ordinary-file unlinking needs no READ_DATA authority.
              IntPtr handle;
              try { handle = OpenRelative(directory, name, isDirectory ? 0x10081U : 0x10080U, 1, 1, isDirectory ? 1U : 0x40U, IntPtr.Zero, out info, true, deadline); }
              catch (Win32Exception error) {
                // An enumerated, delete-pending leaf may finish disappearing
                // while we wait. Only actual absence in this pinned directory
                // is idempotent success; no unknown object is mutated.
                if (error.NativeErrorCode != 2 && error.NativeErrorCode != 3) throw;
                handle = IntPtr.Zero; info = new Info();
              }
              try {
                if (handle != IntPtr.Zero) {
                  if ((info.Attributes & 0x10) != 0 && (info.Attributes & 0x400) == 0) DeleteContents(handle, depth + 1, ref remaining, deadline);
                  DeleteHandle(handle, info, deadline);
                }
              } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
            }
            if (next == 0) break;
            offset += (int)next;
          }
        }
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void DeleteHandle(IntPtr handle, Info info, Stopwatch deadline) {
      Disposition value = new Disposition(); value.Delete = 1;
      while (!SetFileInformationByHandle(handle, 4, ref value, (uint)Marshal.SizeOf(typeof(Disposition)))) {
        int error = Marshal.GetLastWin32Error();
        // Terminated process image/mapped sections can delay unlinking. Retry
        // only the SAME pinned object within the existing shared 5s deadline.
        // Never reopen paths or alter ACLs, attributes, content or identities.
        // A child directory marked for deletion remains a directory entry
        // until its last reference closes. Native control proves 145 here even
        // after anchored enumeration completed. Retry ONLY this verified,
        // ordinary directory handle; never rescan/delete newly appeared data.
        bool pendingDirectory = error == 145 && (info.Attributes & 0x410) == 0x10;
        if ((info.Attributes & 1) != 0 || (error != 5 && error != 32 && error != 33 && !pendingDirectory) || deadline.ElapsedMilliseconds >= 5000) {
          Console.Error.WriteLine("PHI_FILESYSTEM_HANDLE_DISPOSITION_FAILED");
          Failure("DISPOSITION", handle, null, 0x10000, 1, 4, 0, error);
          throw new Win32Exception(error);
        }
        TransientDeleteRetries++;
        System.Threading.Thread.Sleep(10);
      }
    }
    public void Dispose() { for (int index = parents.Count - 1; index >= 0; index--) CloseHandle(parents[index]); parents.Clear(); }
  }
}
