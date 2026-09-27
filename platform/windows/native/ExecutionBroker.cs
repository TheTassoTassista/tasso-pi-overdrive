// Structured, non-interactive LPAC execution. Not the autonomous engine gate.
// Workspace is an explicit bounded snapshot, never a host ACL grant. Publishing
// edits and streaming LSP transport require subsequent production integration.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Phi.Native {
  internal static class ExecutionBroker {
    const int MaxRequest = 1024 * 1024;
    static string Text(object value) {
      string text = value as string;
      if (text == null || text.IndexOf('\0') >= 0) throw new InvalidDataException();
      return text;
    }
    static Dictionary<string, object> Object(object value, params string[] keys) {
      Dictionary<string, object> result = value as Dictionary<string, object>;
      if (result == null || result.Count != keys.Length || keys.Any(k => !result.ContainsKey(k))) throw new InvalidDataException();
      return result;
    }
    static string Relative(string value, bool allowRoot = false) {
      if (allowRoot && value == ".") return value;
      if (value.Length < 1 || value.Length > 512 || value.Split('/').Length > 12) throw new InvalidDataException();
      foreach (string part in value.Split('/')) {
        if (!Regex.IsMatch(part, "\\A[A-Za-z0-9_.-]+\\z") || part == "." || part == ".." || part.EndsWith(".") ||
            Regex.IsMatch(part, "\\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|\\z)|\\A(?:\\.git|\\.env(?:\\..*)?|\\.ssh|\\.aws|auth\\.json|credentials(?:\\.json)?|id_rsa|id_ed25519)\\z|\\.(?:pem|p12|pfx|key)\\z", RegexOptions.IgnoreCase)) throw new InvalidDataException();
      }
      return value.Replace('/', Path.DirectorySeparatorChar);
    }
    static string Hash(byte[] value) {
      using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant();
    }
    internal static int Snapshot(Stream input) {
      try {
        byte[] bytes;
        using (MemoryStream buffer = new MemoryStream()) {
          int next; while ((next = input.ReadByte()) != 10) {
            if (next < 0 || buffer.Length >= 4096) throw new InvalidDataException();
            buffer.WriteByte((byte)next);
          }
          bytes = buffer.ToArray();
        }
        JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 4 * MaxRequest;
        Dictionary<string, object> request = Object(serializer.DeserializeObject(new UTF8Encoding(false, true).GetString(bytes)), "root");
        string root = Text(request["root"]);
        if (!Regex.IsMatch(root, "\\A[A-Za-z]:[\\\\/]") || root.Length > 1024 ||
            root.IndexOf(':', 2) >= 0 || root.EndsWith("\\") || root.EndsWith("/")) throw new InvalidDataException();
        using (RecoveryFilesystem pins = new RecoveryFilesystem(root)) Console.WriteLine(serializer.Serialize(pins.ReadProjectSnapshot()));
        return 0;
      } catch {
        Console.WriteLine("{\"status\":\"FAIL\",\"error\":\"PHI_PROJECT_SNAPSHOT_REJECTED\"}");
        return 70;
      }
    }
    static void CopyRuntime(Dictionary<string, object> executable, string destination) {
      string source = Text(executable["path"]), expected = Text(executable["sha256"]);
      if (!Regex.IsMatch(source, "\\A[A-Za-z]:[\\\\/]") || source.IndexOf(':', 2) >= 0 || !source.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(expected, "\\A[0-9a-f]{64}\\z")) throw new InvalidDataException();
      string name = Path.GetFileNameWithoutExtension(source).ToLowerInvariant();
      if (new string[] { "cmd", "powershell", "pwsh", "wscript", "cscript", "mshta", "rundll32", "regsvr32" }.Contains(name)) throw new InvalidDataException();
      // Pin every source ancestor and the exact final object while copying and
      // hashing; no File.Copy(path) identity/use gap or link substitution.
      using (RecoveryFilesystem pins = new RecoveryFilesystem(Path.GetDirectoryName(source))) {
        RecoveryFilesystem.Info info;
        IntPtr handle = pins.OpenReadFile(Path.GetFileName(source), out info);
        using (SafeFileHandle owned = new SafeFileHandle(handle, true)) {
          if ((info.Attributes & 0x410) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > 128 * 1024 * 1024) throw new InvalidDataException();
          using (FileStream input = new FileStream(owned, FileAccess.Read))
          using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            using (SHA256 sha = SHA256.Create()) {
              byte[] buffer = new byte[65536]; int read; long total = 0;
              while ((read = input.Read(buffer, 0, buffer.Length)) != 0) {
                total += read; if (total > 128 * 1024 * 1024) throw new InvalidDataException();
                sha.TransformBlock(buffer, 0, read, buffer, 0); output.Write(buffer, 0, read);
              }
              sha.TransformFinalBlock(new byte[0], 0, 0);
              if (BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant() != expected) throw new InvalidDataException();
              output.Flush(true);
            }
          }
        }
      }
    }
    internal static int Run(Stream input) {
      AppContainerScope scope = null; OwnedProcess.Capture capture = new OwnedProcess.Capture();
      RecoveryFilesystem draftPins = null; Dictionary<string, object> draft = null; object draftSnapshot = null;
      string profile = null, role = null, operation = null, session = null, failure = "REQUEST";
      int code = 70; bool cleanup = true;
      JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 4 * MaxRequest;
      try {
        byte[] bytes;
        using (MemoryStream buffer = new MemoryStream()) {
          int next; while ((next = input.ReadByte()) != 10) {
            if (next < 0 || buffer.Length >= MaxRequest) throw new InvalidDataException(); buffer.WriteByte((byte)next);
          }
          bytes = buffer.ToArray();
        }
        object parsed = serializer.DeserializeObject(new UTF8Encoding(false, true).GetString(bytes));
        var raw = parsed as Dictionary<string, object>;
        bool hasDraft = raw != null && raw.ContainsKey("draft");
        string[] keys = new string[] { "version", "executable", "argv", "cwd", "environment", "profile", "grants", "network", "timeoutMs", "guardianPid", "context" };
        Dictionary<string, object> request = Object(parsed, hasDraft ? keys.Concat(new string[] { "draft" }).ToArray() : keys);
        if (!(request["version"] is int) || (int)request["version"] != 1 || Text(request["network"]) != "DENY") throw new InvalidDataException();
        Dictionary<string, object> context = Object(request["context"], "sessionId", "operation", "role");
        session = Text(context["sessionId"]); operation = Text(context["operation"]); role = Text(context["role"]); profile = Text(request["profile"]);
        if (!Regex.IsMatch(session, "\\A[0-9a-f]{32}\\z")) throw new InvalidDataException();
        string intended = role == "worker" ? "EDIT" : role == "tester" ? "TEST" : role == "reviewer" || role == "scout" ? "READ_ONLY" : null;
        bool profileAllowed = role == "worker" ? new string[] { "EDIT", "TEST", "READ_ONLY" }.Contains(profile) : profile == intended;
        if (!profileAllowed || intended == null || (operation != "safe-exec" && operation != "verification") || (operation == "verification" && role != "tester")) throw new InvalidDataException();
        if (hasDraft) {
          draft = Object(request["draft"], "id", "revision", "digest");
          if (!Regex.IsMatch(Text(draft["id"]), "\\A[0-9a-f]{32}\\z") || !(draft["revision"] is int) || (int)draft["revision"] < 0 || (int)draft["revision"] > 40 || !Regex.IsMatch(Text(draft["digest"]), "\\A[0-9a-f]{64}\\z") || (role != "worker" && role != "tester")) throw new InvalidDataException();
        }
        IList argv = request["argv"] as IList;
        if (argv == null || argv.Count > 128 || argv.Cast<object>().Any(v => Text(v).Length > 4096)) throw new InvalidDataException();
        string cwd = Relative(Text(request["cwd"]), true);
        if (!(request["timeoutMs"] is int) || (int)request["timeoutMs"] < 1 || (int)request["timeoutMs"] > 120000 || !(request["guardianPid"] is int) || (int)request["guardianPid"] < 1) throw new InvalidDataException();
        Dictionary<string, object> environment = request["environment"] as Dictionary<string, object>;
        if (environment == null || environment.Count > 2 || environment.Any(p => (p.Key != "CI" && p.Key != "NO_COLOR") || Text(p.Value) != "1")) throw new InvalidDataException();
        Dictionary<string, object> grants = Object(request["grants"], "workspace", "assets");
        var collections = new Dictionary<string, Dictionary<string, string>>(); int totalBytes = 0, totalFiles = 0;
        foreach (string space in new string[] { "workspace", "assets" }) {
          Dictionary<string, object> files = grants[space] as Dictionary<string, object>;
          if (files == null) throw new InvalidDataException();
          var validated = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
          foreach (var file in files) {
            string name = Relative(file.Key), value = Text(file.Value);
            totalBytes += Encoding.UTF8.GetByteCount(value); totalFiles++;
            if (totalBytes > 512 * 1024 || totalFiles > 256 || validated.ContainsKey(name)) throw new InvalidDataException();
            validated.Add(name, value);
          }
          collections.Add(space, validated);
        }
        Dictionary<string, object> executable = Object(request["executable"], "path", "sha256");
        failure = "SCOPE"; scope = new AppContainerScope();
        Console.WriteLine(serializer.Serialize(new { kind = "admitted", scopeId = scope.Id })); Console.Out.Flush();
        scope.CreateBrokerRoot();
        string runtime = Path.Combine(scope.Root, "runtime"), workspace = Path.Combine(scope.Root, "workspace"), scratch = Path.Combine(scope.Root, "scratch"), assets = Path.Combine(scope.Root, "assets");
        foreach (string directory in new string[] { runtime, workspace, scratch, assets }) Directory.CreateDirectory(directory);
        // CreateProcess reroutes TEMP/TMP beneath the supplied LOCALAPPDATA.
        // Provision only this fresh profile's exact nested temp authority;
        // never grant the host home or patch the suspended process environment.
        Directory.CreateDirectory(Path.Combine(scratch, "Packages", "Phi.Probe." + scope.Id, "AC", "Temp"));
        failure = "RUNTIME"; string command = Path.Combine(runtime, "program.exe"); CopyRuntime(executable, command);
        failure = "GRANTS";
        foreach (var collection in collections) foreach (var file in collection.Value) {
          string destination = Path.Combine(collection.Key == "workspace" ? workspace : assets, file.Key);
          Directory.CreateDirectory(Path.GetDirectoryName(destination)); File.WriteAllText(destination, file.Value, new UTF8Encoding(false));
        }
        string working = cwd == "." ? workspace : Path.Combine(workspace, cwd);
        if (!Directory.Exists(working)) throw new InvalidDataException();
        scope.SetDirectoryAuthority(scope.Root, true, false); scope.SetDirectoryAuthority(runtime, true, false);
        scope.SetDirectoryAuthority(workspace, true, profile == "EDIT"); scope.SetDirectoryAuthority(assets, true, false); scope.SetDirectoryAuthority(scratch, true, true);
        scope.PrepareBrokerAttestation((int)request["guardianPid"], runtime);
        string system = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var env = new Dictionary<string, string> { { "SystemRoot", system }, { "windir", system }, { "SystemDrive", Path.GetPathRoot(system).TrimEnd('\\') }, { "PATH", runtime }, { "USERPROFILE", scratch }, { "LOCALAPPDATA", scratch }, { "APPDATA", scratch }, { "TEMP", scratch }, { "TMP", scratch }, { "PHI_TOOL_ASSETS", assets } };
        foreach (var pair in environment) env.Add(pair.Key, Text(pair.Value));
        var launch = new { command, args = argv, cwd = working, env, timeoutMs = request["timeoutMs"], guardianPid = request["guardianPid"] };
        failure = "LAUNCH";
        // Pin the actual workspace and all ancestors BEFORE the untrusted
        // target starts; readback cannot be redirected to a replacement path.
        if (draft != null) draftPins = new RecoveryFilesystem(workspace);
        using (MemoryStream pipe = new MemoryStream(Encoding.UTF8.GetBytes(serializer.Serialize(launch) + "\n"))) code = OwnedProcess.Execute(pipe, scope, capture);
        if (!scope.TokenVerified || !capture.JobAttested || !capture.Started || !capture.Drained) code = 70;
        failure = code == 70 ? "EXECUTION" : null;
        if (draft != null && code == 0) {
          failure = "DRAFT";
          if (!capture.JobEmptyVerified) throw new InvalidDataException();
          // Reject protected names, aliases, non-UTF8 and overflow. Never
          // silently omit an unsafe output and call the remaining draft valid.
          draftSnapshot = draftPins.ReadProjectSnapshot(true);
          failure = null;
        }
      } catch {
        code = 70;
        if (failure == "REQUEST") { profile = null; role = null; operation = null; session = null; }
      }
      finally {
        if (draftPins != null) draftPins.Dispose();
        if (scope != null) cleanup = scope.FinishBroker();
        if (!cleanup) { code = 70; failure = "CLEANUP"; }
        if (code != 0) draftSnapshot = null;
      }
      // Child stdout/stderr never share the control channel: no forged receipt.
      // Tool output is an artifact, explicitly separate from metadata receipt.
      var result = new Dictionary<string, object> {
        { "kind", "result" }, { "stdoutBase64", Convert.ToBase64String(capture.Drained ? capture.Output.ToArray() : new byte[0]) }, { "stderrBase64", Convert.ToBase64String(capture.Drained ? capture.Error.ToArray() : new byte[0]) },
        { "receipt", new { version = 1, platform = "win32", backend = "windows-lpac-broker", profile, role, operation, sessionId = session, scopeId = scope == null ? null : scope.Id, tokenVerified = scope != null && scope.TokenVerified, jobAttested = capture.JobAttested, targetStarted = capture.Started, exitCode = code, timedOut = code == 124, cleanup = cleanup ? "PASS" : "FAIL", securityFailure = failure } }
      };
      if (draft != null) result.Add("draft", new { id = draft["id"], revision = draft["revision"], digest = draft["digest"], snapshot = draftSnapshot, jobEmptyVerified = capture.JobEmptyVerified });
      Console.WriteLine(serializer.Serialize(result));
      capture.Overflow.Dispose(); return code;
    }
  }
}
