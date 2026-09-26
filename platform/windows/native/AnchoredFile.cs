// Handle-anchored bounded mutation primitive. Not yet an EditEngine backend:
// in-place writes are NOT crash-atomic; generic coding remains blocked.
using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Phi.Native {
  internal sealed class AnchoredFile : IDisposable {
    const int MaxBytes = 1024 * 1024;
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file, out RecoveryFilesystem.Info info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFilePointerEx(IntPtr file, long distance, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr file, byte[] value, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr file, byte[] value, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetEndOfFile(IntPtr file);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr file);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateHardLinkW(string link, string target, IntPtr attributes);
    readonly RecoveryFilesystem rootPins, parentPins;
    IntPtr handle;
    internal string Identity { get { return RecoveryFilesystem.HandleIdentity(handle); } }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string[] Segments(string relative) {
      if (String.IsNullOrEmpty(relative) || relative.Length > 1024 || relative.IndexOfAny(new char[] { '\\', ':', '\0', '<', '>', '"', '|', '?', '*' }) >= 0) throw new InvalidDataException();
      string[] parts = relative.Split('/');
      string[] blocked = { ".git", "node_modules", ".aws", ".gnupg", ".password-store", ".ssh", "browser-data", "keyrings", ".env", "auth.json", "credentials", "credentials.json", "id_dsa", "id_ed25519", "id_ecdsa", "id_rsa", "known_hosts", "netrc" };
      foreach (string part in parts) {
        if (part.Length == 0 || part == "." || part == ".." || part.Any(c => c < 32) || part.EndsWith(".") || part.EndsWith(" ") || blocked.Contains(part.ToLowerInvariant()) || part.StartsWith(".env.", StringComparison.OrdinalIgnoreCase) || Regex.IsMatch(part, "\\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|\\z)|\\.(?:pem|p12|pfx|key)\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) throw new InvalidDataException();
      }
      return parts;
    }
    internal AnchoredFile(string root, string rootIdentity, string relative) {
      string[] segments = Segments(relative);
      try {
        rootPins = new RecoveryFilesystem(root);
        if (RecoveryFilesystem.DirectoryIdentity(root) != rootIdentity) throw new InvalidDataException();
        string target = segments.Aggregate(root, (current, part) => Path.Combine(current, part));
        parentPins = new RecoveryFilesystem(Path.GetDirectoryName(target));
        RecoveryFilesystem.Info info;
        handle = parentPins.OpenFile(segments[segments.Length - 1], out info);
        Validate(info);
      } catch { Dispose(); throw; }
    }
    static void Validate(RecoveryFilesystem.Info info) {
      if ((info.Attributes & (0x10 | 0x400)) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > MaxBytes) throw new InvalidDataException();
    }
    void Validate() { RecoveryFilesystem.Info info; Check(GetFileInformationByHandle(handle, out info)); Validate(info); }
    void Rewind() { long position; Check(SetFilePointerEx(handle, 0, out position, 0)); if (position != 0) throw new InvalidDataException(); }
    byte[] Read() {
      Validate(); Rewind();
      using (MemoryStream buffer = new MemoryStream()) {
        byte[] chunk = new byte[4096]; uint read;
        do {
          Check(ReadFile(handle, chunk, (uint)chunk.Length, out read, IntPtr.Zero));
          if (read > chunk.Length || buffer.Length + read > MaxBytes) throw new InvalidDataException();
          buffer.Write(chunk, 0, (int)read);
        } while (read != 0);
        return buffer.ToArray();
      }
    }
    static string Hash(byte[] value) { using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
    internal string Digest { get { return Hash(Read()); } }
    internal void Write(string expectedIdentity, string expectedDigest, byte[] value) {
      if (value == null || value.Length > MaxBytes || Identity != expectedIdentity || Digest != expectedDigest) throw new InvalidDataException();
      Validate(); Rewind(); uint written;
      Check(WriteFile(handle, value, (uint)value.Length, out written, IntPtr.Zero));
      if (written != value.Length) throw new InvalidDataException();
      Check(SetEndOfFile(handle)); Check(FlushFileBuffers(handle));
      if (Identity != expectedIdentity || Digest != Hash(value)) throw new InvalidDataException();
    }
    public void Dispose() {
      if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero;
      if (parentPins != null) parentPins.Dispose(); if (rootPins != null) rootPins.Dispose();
    }
    internal static int SelfTest(string name) {
      string[] cases = { "write", "replace-before-open", "rename-while-open", "delete-while-open", "directory-swap", "hardlink", "junction", "case-alias", "ads", "protected", "changed-content", "parent-reparse-while-pinned", "create-through-junction" };
      if (!cases.Contains(name)) return 70;
      ScopeRecovery scope = null; bool passed = false, clean = true;
      try {
        scope = ScopeRecovery.Begin(); scope.CreateRoot(); scope.Ready();
        string rootId = RecoveryFilesystem.DirectoryIdentity(scope.Root), directory = Path.Combine(scope.Root, "src");
        Directory.CreateDirectory(directory);
        string file = Path.Combine(directory, "fixture.txt"), outside = Path.Combine(scope.Root, "unrelated.txt");
        File.WriteAllText(file, "synthetic-original"); File.WriteAllText(outside, "synthetic-unrelated");
        if (name == "parent-reparse-while-pinned" || name == "create-through-junction") {
          string empty = Path.Combine(scope.Root, "empty"), target = Path.Combine(scope.Root, "unrelated-directory");
          Directory.CreateDirectory(empty); Directory.CreateDirectory(target);
          File.WriteAllText(Path.Combine(target, "sentinel.txt"), "synthetic-unrelated");
          bool blocked = false;
          if (name == "parent-reparse-while-pinned") {
            using (RecoveryFilesystem pins = new RecoveryFilesystem(empty)) {
              try { AppContainerScope.CreateOwnedJunction(empty, target); }
              catch (Win32Exception error) { if (error.NativeErrorCode != 32 && error.NativeErrorCode != 33) throw; blocked = true; }
              if (!blocked) {
                try { pins.CreateChildDirectory("escape", Directory.GetAccessControl(target)); }
                catch (InvalidDataException) { blocked = true; }
              }
              if (Directory.Exists(Path.Combine(target, "escape"))) throw new InvalidDataException();
            }
            if (!blocked) throw new InvalidDataException();
          }
          // Positive control: with the authority handles closed, the identical
          // reparse operation must succeed and its real target must be readable.
          if ((File.GetAttributes(empty) & FileAttributes.ReparsePoint) == 0) AppContainerScope.CreateOwnedJunction(empty, target);
          if (File.ReadAllText(Path.Combine(empty, "sentinel.txt")) != "synthetic-unrelated") throw new InvalidDataException();
          if (name == "create-through-junction") {
            try { RecoveryFilesystem.CreateDirectory(Path.Combine(empty, "escape"), Directory.GetAccessControl(target), false); }
            catch (InvalidDataException) { blocked = true; }
            if (!blocked || Directory.Exists(Path.Combine(target, "escape"))) throw new InvalidDataException();
          }
        }
        string id, hash;
        using (AnchoredFile snapshot = new AnchoredFile(scope.Root, rootId, "src/fixture.txt")) { id = snapshot.Identity; hash = snapshot.Digest; }
        if (name == "replace-before-open") { File.Move(file, file + ".old"); File.WriteAllText(file, "synthetic-replacement"); }
        if (name == "changed-content") File.WriteAllText(file, "synthetic-changed");
        if (name == "hardlink") { File.Delete(file); Check(CreateHardLinkW(file, outside, IntPtr.Zero)); }
        if (name == "junction") { Directory.Move(directory, directory + "-old"); AppContainerScope.CreateOwnedJunction(directory, directory + "-old"); }
        bool denied = false, competingDenied = false;
        try {
          string relative = name == "ads" ? "src/fixture.txt:alternate" : name == "protected" ? ".env" : name == "case-alias" ? "SRC/FIXTURE.TXT" : "src/fixture.txt";
          using (AnchoredFile target = new AnchoredFile(scope.Root, rootId, relative)) {
            if (name == "rename-while-open" || name == "delete-while-open" || name == "directory-swap") {
              try {
                if (name == "rename-while-open") File.Move(file, file + ".moved");
                else if (name == "delete-while-open") File.Delete(file);
                else Directory.Move(directory, directory + "-moved");
              } catch (IOException) { competingDenied = true; }
              if (!competingDenied) throw new InvalidOperationException();
            }
            target.Write(id, hash, Encoding.UTF8.GetBytes("synthetic-edited"));
          }
        } catch (InvalidDataException) { denied = true; }
        bool shouldDeny = name == "replace-before-open" || name == "changed-content" || name == "hardlink" || name == "junction" || name == "ads" || name == "protected";
        if (denied != shouldDeny || File.ReadAllText(outside) != "synthetic-unrelated") throw new InvalidDataException();
        string expected = name == "replace-before-open" ? "synthetic-replacement" : name == "changed-content" ? "synthetic-changed" : name == "hardlink" ? "synthetic-unrelated" : shouldDeny ? "synthetic-original" : "synthetic-edited";
        if (File.ReadAllText(file) != expected) throw new InvalidDataException();
        passed = true;
      } catch (Exception error) { RecoveryFilesystem.LogFailure(error); Console.Error.WriteLine("PHI_ANCHORED_FILE_SELFTEST_FAILED"); }
      finally { try { if (scope != null) { scope.CleanupFiles(); scope.Complete(true); } } catch { clean = false; if (scope != null) scope.Dispose(); Console.Error.WriteLine("PHI_ANCHORED_FILE_CLEANUP_FAILED"); } }
      Console.WriteLine(new JavaScriptSerializer().Serialize(new { caseName = name, passed, fixtureCleanup = clean, scope = "HANDLE_MUTATION_PRIMITIVE_NOT_TRANSACTIONAL_ENGINE" }));
      return passed && clean ? 0 : 70;
    }
  }
}
