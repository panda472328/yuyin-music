using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Yuyin.WindowsHost;

public static class UpdateTests
{
    public static async Task Run()
    {
        var directory = Path.Combine(Path.GetTempPath(), "yuyin-update-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var checks = 0;
        void Assert(bool result, string name) { if (!result) throw new Exception("FAIL update: " + name); checks++; }
        void Reject(Action action, string name) { try { action(); } catch { checks++; return; } throw new Exception("FAIL update: " + name); }
        var payload = Encoding.UTF8.GetBytes("MZ controlled test update, never launched");
        var manifest = Manifest("0.5.1", payload);
        var json = JsonSerializer.Serialize(manifest);
        string Changed(Action<JsonObject> change)
        {
            var node = JsonNode.Parse(json)!.AsObject(); change(node); return node.ToJsonString();
        }
        try
        {
            Assert(UpdateService.ParseManifest(json) == manifest, "public manifest contract");
            Assert(UpdateService.CompareVersions("0.5.1", "0.5.0") > 0 && UpdateService.CompareVersions("1.0.0", "0.999999.999999") > 0, "numeric version comparison");
            foreach (var version in new[] { "0.4.03", "1.2", "1.2.3.4", "1.2.3-beta", "9999999.0.0", "1.2.3\n" }) Assert(!UpdateService.IsStableVersion(version), "reject version " + version.Trim());
            Reject(() => UpdateService.ParseManifest(Changed(value => value["platform"] = "android")), "wrong platform");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["schemaVersion"] = 2)), "wrong schema");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["versionCode"] = 1)), "Android field forbidden");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["artifact"]!["url"] = "https://github.com/other/repository/evil.exe")), "wrong repository");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["artifact"]!["sha256"] = manifest.Artifact.Sha256.ToUpperInvariant())), "noncanonical digest");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["artifact"]!["size"] = 0)), "zero size");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["artifact"]!["size"] = UpdateService.MaxUpdateBytes + 1)), "oversized artifact");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["releaseNotesUrl"] = UpdateService.LatestReleaseUrl)), "notes URL version fixed");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["notes"] = new string('x', 8001))), "bounded notes");
            Reject(() => UpdateService.ParseManifest(Changed(value => value["publishedAt"] = "2026-02-30T00:00:00Z")), "invalid date");
            Assert(UpdateService.IsTrustedAddress(new(UpdateService.ManifestUrl), true), "fixed public manifest allowed");
            Assert(!UpdateService.IsTrustedAddress(new(UpdateService.ManifestUrl + "?token=x"), true), "manifest query refused");
            Assert(UpdateService.IsTrustedAddress(new("https://release-assets.githubusercontent.com/test?signature=controlled"), false), "GitHub release CDN allowed");
            foreach (var address in new[] { "http://github.com/panda472328/yuyin-music/releases/download/file", "https://github.com/other/repo/releases/download/file", "https://evil.example/file", "https://github.com:444/panda472328/yuyin-music/releases/download/file", "https://user:pass@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com/file#hash" })
                Assert(!UpdateService.IsTrustedAddress(new(address), false), "untrusted redirect refused");

            var markerDirectory = Path.Combine(directory, "marker"); Directory.CreateDirectory(markerDirectory);
            Assert(!UpdateService.IsInstalledBuild(markerDirectory), "portable marker absent");
            File.WriteAllText(Path.Combine(markerDirectory, UpdateService.InstalledMarkerName), "wrong");
            Assert(!UpdateService.IsInstalledBuild(markerDirectory), "marker content validated");
            File.WriteAllText(Path.Combine(markerDirectory, UpdateService.InstalledMarkerName), UpdateService.InstalledMarkerContent);
            Assert(UpdateService.IsInstalledBuild(markerDirectory), "installed marker recognized");

            var file = Path.Combine(directory, "controlled.exe"); await File.WriteAllBytesAsync(file, payload);
            Assert(await UpdateService.VerifyUpdateFileAsync(file, manifest), "digest and size verified");
            await File.WriteAllBytesAsync(file, payload.Concat(new byte[] { 0 }).ToArray());
            Assert(!await UpdateService.VerifyUpdateFileAsync(file, manifest), "wrong size rejected");
            await File.WriteAllBytesAsync(file, payload.Select(value => (byte)(value ^ 1)).ToArray());
            Assert(!await UpdateService.VerifyUpdateFileAsync(file, manifest), "same-size corruption rejected");
            var launcher = UpdateService.CreateInstallerStartInfo(file, 12345);
            Assert(launcher.ArgumentList.SequenceEqual(new[] { "/YUYINPID=12345" }), "installer waits for exact host pid");
            Assert(UpdateService.CreateInstallerStartInfo(file, 12345, true).ArgumentList.Contains("/S"), "silent is optional");
            Reject(() => UpdateService.CreateInstallerStartInfo("relative.exe", 1), "absolute installer path required");

            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var downloadGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var requests = new List<string>(); var installed = 0; var states = new List<string>();
            var handler = new ControlledHandler(async (request, token) =>
            {
                requests.Add(request.RequestUri!.AbsoluteUri);
                if (request.RequestUri.AbsoluteUri == UpdateService.ManifestUrl) { await gate.Task.WaitAsync(token); return Text(json); }
                await downloadGate.Task.WaitAsync(token);
                Assert(request.Headers.AcceptEncoding.ToString() == "identity", "unencoded update transport");
                return Bytes(payload);
            });
            using (var updater = new UpdateService(Path.Combine(directory, "success"), (download, current) => { installed++; Assert(File.Exists(download) && current == manifest, "only verified file reaches installer callback"); return Task.CompletedTask; }, "0.5.0", true, handler))
            {
                updater.StateChanged += state => states.Add(state.Status);
                var check = updater.CheckAsync();
                Assert(ReferenceEquals(check, updater.CheckAsync()), "check operation single flight");
                gate.SetResult();
                Assert((await check).Status == "available", "new version available");
                Assert(requests.Count == 1 && installed == 0, "check cannot download or install");
                var download = updater.DownloadAsync();
                Assert(ReferenceEquals(download, updater.DownloadAsync()), "download operation single flight");
                downloadGate.SetResult();
                Assert((await download).Status == "downloaded", "download verified");
                Assert(installed == 0, "download cannot install");
                var before = requests.Count;
                Assert((await updater.DownloadAsync()).Status == "downloaded" && requests.Count == before, "verified cache reused");
                Assert((await updater.InstallAsync()).Status == "installing" && installed == 1, "explicit install invokes callback once");
                Assert(states.Contains("checking") && states.Contains("available") && states.Contains("downloading") && states.Contains("downloaded") && states.Contains("installing"), "frontend states compatible");
            }

            using (var cached = new UpdateService(Path.Combine(directory, "success"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((_, _) => Task.FromResult(Text(json)))))
                Assert((await cached.CheckAsync()).Status == "downloaded", "restart detects fully verified cache");
            using (var current = new UpdateService(Path.Combine(directory, "current"), (_, _) => throw new Exception("not authorized"), "0.5.1", true, new ControlledHandler((_, _) => Task.FromResult(Text(json)))))
                Assert((await current.CheckAsync()).Status == "up-to-date" && current.State.Manifest is null, "equal version does not offer update");

            var portableRequests = 0;
            using (var portable = new UpdateService(Path.Combine(directory, "portable"), (_, _) => throw new Exception("not authorized"), "0.5.0", false, new ControlledHandler((_, _) => { portableRequests++; return Task.FromResult(Text(json)); })))
            {
                Assert((await portable.CheckAsync()).Status == "available" && !portable.State.CanInstall, "portable detects update with manual installation");
                Assert((await portable.DownloadAsync()).Status == "error", "portable cannot download installation");
                Assert((await portable.InstallAsync()).Status == "error" && portableRequests == 1, "portable cannot install");
            }

            var wrong = payload.Select(value => (byte)(value ^ 1)).ToArray(); var attempt = 0;
            using (var retry = new UpdateService(Path.Combine(directory, "retry"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) => Task.FromResult(request.RequestUri!.AbsoluteUri == UpdateService.ManifestUrl ? Text(json) : Bytes(attempt++ == 0 ? wrong : payload)))))
            {
                await retry.CheckAsync();
                Assert((await retry.DownloadAsync()).Status == "error", "digest mismatch is visible error");
                Assert(!Directory.EnumerateFiles(Path.Combine(directory, "retry"), "*.part").Any(), "failed partial removed");
                Assert((await retry.DownloadAsync()).Status == "downloaded", "failed download can retry");
            }

            var evilCalls = 0;
            using (var redirected = new UpdateService(Path.Combine(directory, "redirect"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                evilCalls++;
                if (request.RequestUri!.AbsoluteUri == UpdateService.ManifestUrl) return Task.FromResult(Text(json));
                var result = new HttpResponseMessage(HttpStatusCode.Found); result.Headers.Location = new("https://evil.example/update.exe?secret=hidden"); return Task.FromResult(result);
            })))
            {
                await redirected.CheckAsync();
                Assert((await redirected.DownloadAsync()).Status == "error" && evilCalls == 2, "untrusted redirect blocked before request");
                Assert(!redirected.State.Error!.Contains("secret"), "network error does not expose redirect query");
            }

            var startedCalls = 0;
            var startupGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using (var started = new UpdateService(Path.Combine(directory, "start"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler(async (_, token) => { Interlocked.Increment(ref startedCalls); await startupGate.Task.WaitAsync(token); return Text(json); })))
            {
                started.Start(); started.Start();
                var check = started.CheckAsync(); startupGate.SetResult(); await check;
                Assert(startedCalls == 1, "startup check starts once");
            }
            Assert(!Directory.EnumerateFiles(directory, "*.part", SearchOption.AllDirectories).Any(), "all partial files cleaned");
            Console.WriteLine($"{checks} native update checks passed using controlled responses; no update was launched.");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static WindowsUpdateManifest Manifest(string version, byte[] payload) => new(1, "windows", version, new(UpdateService.ArtifactUrl(version), Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant(), payload.Length), UpdateService.ReleaseNotesUrl(version), "受控更新测试", "2026-10-11T12:00:00.000Z");
    private static HttpResponseMessage Text(string value) => new(HttpStatusCode.OK) { Content = new StringContent(value, Encoding.UTF8, "application/json") };
    private static HttpResponseMessage Bytes(byte[] value) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(value) };
    private sealed class ControlledHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> response) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => response(request, cancellationToken);
    }
}
