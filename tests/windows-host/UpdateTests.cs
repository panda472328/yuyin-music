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
            var domestic = Domestic(manifest);
            var domesticJson = JsonSerializer.Serialize(domestic);
            Assert(UpdateService.ParseDomesticManifest(domesticJson) == domestic, "separate domestic manifest contract");
            var contents = Contents(domesticJson);
            var contentsJson = JsonSerializer.Serialize(contents);
            Assert(UpdateService.DecodeDomesticContents(contentsJson) == domesticJson, "fixed Contents API decodes bounded UTF-8 base64 manifest");
            string ContentsChanged(Action<JsonObject> change) { var node = JsonNode.Parse(contentsJson)!.AsObject(); change(node); return node.ToJsonString(); }
            foreach (var invalid in new[] {
                "[]", domesticJson, ContentsChanged(value => value["type"] = "dir"), ContentsChanged(value => value["encoding"] = "utf8"),
                ContentsChanged(value => value["path"] = "updates/stable.json"), ContentsChanged(value => value["name"] = "stable.json"),
                ContentsChanged(value => value["size"] = 0), ContentsChanged(value => value["size"] = UpdateService.ManifestMaxBytes + 1),
                ContentsChanged(value => value["size"] = 1), ContentsChanged(value => value["content"] = "a==="),
                ContentsChanged(value => value["content"] = new string('A', UpdateService.DomesticContentsMaxBytes + 1)),
                ContentsChanged(value => { value["size"] = 1; value["content"] = "/w=="; }),
                ContentsChanged(value => { value["size"] = 1; value["content"] = "Zh=="; }),
            }) Reject(() => UpdateService.DecodeDomesticContents(invalid), "Contents wrapper rejects path, bounds, base64 aliases and invalid UTF-8");
            Assert(UpdateService.DecodeDomesticContents(ContentsChanged(value => value["content"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(domesticJson)).Insert(20, "\r\n"))) == domesticJson, "Contents base64 line wrapping accepted");
            string DomesticChanged(Action<JsonObject> change) { var node = JsonNode.Parse(domesticJson)!.AsObject(); change(node); return node.ToJsonString(); }
            foreach (var invalid in new[]
            {
                DomesticChanged(value => value["schemaVersion"] = 1), DomesticChanged(value => value["provider"] = "github"),
                DomesticChanged(value => value["versionCode"] = 1), DomesticChanged(value => value["source"]!["releaseId"] = 0),
                DomesticChanged(value => value["source"]!["attachmentId"] = 2147483648L), DomesticChanged(value => value["source"]!["filename"] = "evil.exe"),
                DomesticChanged(value => value["artifact"]!["url"] = domestic.Artifact.Url + "?access_token=hidden"),
                DomesticChanged(value => value["artifact"]!["url"] = domestic.Artifact.Url.Replace("openmusic/openmusic", "evil/repo")),
                DomesticChanged(value => value["releaseNotesUrl"] = domestic.ReleaseNotesUrl.Replace("0.5.1", "0.5.2")),
                DomesticChanged(value => value["artifact"]!["sha256"] = "wrong"), DomesticChanged(value => value["artifact"]!["size"] = 0),
            }) Reject(() => UpdateService.ParseDomesticManifest(invalid), "domestic schema pins identity and legacy validations");
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
            Assert(UpdateService.IsTrustedAddress(new(UpdateService.DomesticManifestUrl), true), "fixed domestic manifest allowed");
            Assert(!UpdateService.IsTrustedAddress(new(UpdateService.DomesticManifestUrl + "?token=x"), true), "domestic manifest query refused");
            Assert(!UpdateService.IsTrustedAddress(new(UpdateService.DomesticManifestUrl.Replace("ref=main", "ref=evil")), true), "domestic branch pinned");
            Assert(!UpdateService.IsTrustedAddress(new("https://raw.giteeusercontent.com/openmusic/openmusic/raw/main/updates/domestic.json?metadata=x&signature=x"), true, new(UpdateService.DomesticManifestUrl)), "Contents manifest never follows raw signed CDN URLs");
            Assert(UpdateService.IsTrustedAddress(new(domestic.Artifact.Url), false, new(domestic.Artifact.Url)), "official Gitee attachment download API allowed");
            var expectedFilename = "Yuyin-0.5.1-Setup.exe";
            var signedCdn = $"https://foruda.gitee.com/attach_file/1662036200660558629/{expectedFilename}?token={new string('a', 32)}&ts=1791780000&attname={expectedFilename}";
            Assert(UpdateService.IsTrustedAddress(new(signedCdn), false, new(domestic.Artifact.Url), expectedFilename), "observed API-issued foruda redirect allowed for exact installer");
            var lowercasePath = signedCdn.Replace($"/{expectedFilename}?", $"/{expectedFilename.ToLowerInvariant()}?");
            Assert(UpdateService.IsTrustedAddress(new(lowercasePath), false, new(domestic.Artifact.Url), expectedFilename), "foruda path filename comparison ignores case");
            Assert(!UpdateService.IsTrustedAddress(new(lowercasePath.Replace($"attname={expectedFilename}", $"attname={expectedFilename.ToLowerInvariant()}")), false, new(domestic.Artifact.Url), expectedFilename), "foruda attname remains exact");
            Assert(!UpdateService.IsTrustedAddress(new(signedCdn), false), "foruda is never an initial installer URL");
            Assert(!UpdateService.IsTrustedAddress(new(signedCdn), true, new(UpdateService.DomesticManifestUrl), expectedFilename), "manifest cannot use attachment CDN");
            foreach (var invalid in new[] {
                signedCdn.Replace("https:", "http:"), signedCdn.Replace("foruda.gitee.com", "foruda.gitee.com.evil.example"),
                signedCdn.Replace("foruda.gitee.com", "user:pass@foruda.gitee.com"), signedCdn.Replace("foruda.gitee.com", "foruda.gitee.com:444"),
                signedCdn.Replace("/attach_file/", "/other/"), signedCdn.Replace("0.5.1", "0.5.2"),
                signedCdn.Replace("attname=Yuyin-0.5.1", "attname=Yuyin-0.5.2"), signedCdn + "&access_token=hidden", signedCdn + "&token=" + new string('b', 32),
                signedCdn.Replace("token=", "unknown="), signedCdn.Replace(new string('a', 32), "invalid"), signedCdn.Replace("ts=1791780000", "ts=invalid"), signedCdn + "#fragment",
            }) Assert(!UpdateService.IsTrustedAddress(new(invalid), false, new(domestic.Artifact.Url), expectedFilename), "foruda redirect identity and signature fields pinned");
            Assert(!UpdateService.IsTrustedAddress(new("https://unknown-cdn.example/download"), false, new(domestic.Artifact.Url)), "unknown domestic CDN never trusted");
            Assert(!UpdateService.IsTrustedAddress(new(manifest.Artifact.Url), false, new(domestic.Artifact.Url)), "provider crossing cannot happen through redirect");
            Assert(!UpdateService.IsTrustedAddress(new(UpdateService.ArtifactUrl("0.5.2")), false, new(manifest.Artifact.Url)), "GitHub redirect cannot switch versions");
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

            var domesticRequests = new List<string>();
            using (var missingDomestic = new UpdateService(Path.Combine(directory, "domestic-api-missing"), (_, _) => throw new Exception("not authorized"), "0.5.0", true,
                new ControlledHandler((request, _) => Task.FromResult(Text(request.RequestUri!.AbsoluteUri == UpdateService.DomesticManifestUrl ? "[]" : json)), acceptDomestic: true)))
                Assert((WindowsUpdateManifest?)(await missingDomestic.CheckAsync()).Manifest == manifest, "Gitee missing file 200 empty array safely falls back to GitHub");
            using (var preferred = new UpdateService(Path.Combine(directory, "domestic"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                var uri = request.RequestUri!.AbsoluteUri; domesticRequests.Add(uri);
                return Task.FromResult(uri == UpdateService.DomesticManifestUrl ? DomesticText(domesticJson) : uri == UpdateService.ManifestUrl ? Text(json) : Bytes(payload));
            }, acceptDomestic: true)))
            {
                Assert((WindowsUpdateManifest?)(await preferred.CheckAsync()).Manifest == domestic, "same-version domestic source preferred");
                Assert(domesticRequests.Count == 2, "both manifests checked without artifact download");
                Assert((await preferred.DownloadAsync()).Status == "downloaded" && domesticRequests.Last() == domestic.Artifact.Url, "domestic attachment downloaded and verified");
            }

            var cdnCalls = new List<string>();
            using (var observedCdn = new UpdateService(Path.Combine(directory, "domestic-foruda"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                var uri = request.RequestUri!.AbsoluteUri; cdnCalls.Add(uri);
                Assert(request.Headers.Authorization is null && !request.Headers.Contains("Cookie"), "API and foruda requests remain anonymous");
                return Task.FromResult(uri == UpdateService.DomesticManifestUrl ? DomesticText(domesticJson) : uri == UpdateService.ManifestUrl ? Text(json)
                    : uri == domestic.Artifact.Url ? Redirect(signedCdn) : Bytes(payload));
            }, acceptDomestic: true)))
            {
                await observedCdn.CheckAsync();
                Assert((await observedCdn.DownloadAsync()).Status == "downloaded" && cdnCalls.TakeLast(2).SequenceEqual(new[] { domestic.Artifact.Url, signedCdn }), "one observed API to foruda redirect downloads verified bytes");
                Assert(((WindowsUpdateManifest?)observedCdn.State.Manifest)?.Artifact.Url == domestic.Artifact.Url, "expiring signature is never persisted as artifact identity");
            }

            var secondCdn = signedCdn.Replace("1662036200660558629", "1662036200660558630"); var chainedCalls = new List<string>();
            using (var chained = new UpdateService(Path.Combine(directory, "domestic-foruda-chain"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                var uri = request.RequestUri!.AbsoluteUri; chainedCalls.Add(uri);
                return Task.FromResult(uri == UpdateService.DomesticManifestUrl ? DomesticText(domesticJson) : uri == UpdateService.ManifestUrl ? Text(json)
                    : uri == domestic.Artifact.Url ? Redirect(signedCdn) : uri == signedCdn ? Redirect(secondCdn) : Bytes(payload));
            }, acceptDomestic: true)))
            {
                await chained.CheckAsync();
                Assert((await chained.DownloadAsync()).Status == "downloaded" && !chainedCalls.Contains(secondCdn) && chainedCalls.Last() == manifest.Artifact.Url, "second foruda hop rejected before request then same bytes fallback verified");
            }

            var signatureCalls = new List<string>(); var apiAttempts = 0;
            var refreshedCdn = signedCdn.Replace(new string('a', 32), new string('b', 32));
            using (var expired = new UpdateService(Path.Combine(directory, "domestic-foruda-expired"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                var uri = request.RequestUri!.AbsoluteUri; signatureCalls.Add(uri);
                if (uri == manifest.Artifact.Url) throw new HttpRequestException("Controlled fallback unavailable.");
                return Task.FromResult(uri == UpdateService.DomesticManifestUrl ? DomesticText(domesticJson) : uri == UpdateService.ManifestUrl ? Text(json)
                    : uri == domestic.Artifact.Url ? Redirect(++apiAttempts == 1 ? signedCdn : refreshedCdn)
                    : uri == signedCdn ? new HttpResponseMessage(HttpStatusCode.Forbidden) : Bytes(payload));
            }, acceptDomestic: true)))
            {
                await expired.CheckAsync();
                Assert((await expired.DownloadAsync()).Status == "error", "expired CDN signature cannot become a downloaded file");
                Assert((await expired.DownloadAsync()).Status == "downloaded" && apiAttempts == 2 && signatureCalls.Last() == refreshedCdn, "explicit retry starts fixed API again to obtain a fresh signature");
                Assert(!Directory.EnumerateFiles(Path.Combine(directory, "domestic-foruda-expired"), "*.part").Any(), "expired signature partials removed before fresh attempt");
            }

            var failoverCalls = new List<string>();
            using (var failover = new UpdateService(Path.Combine(directory, "domestic-failover"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                var uri = request.RequestUri!.AbsoluteUri; failoverCalls.Add(uri);
                return Task.FromResult(uri == UpdateService.DomesticManifestUrl ? DomesticText(domesticJson) : uri == UpdateService.ManifestUrl ? Text(json) : Bytes(uri == domestic.Artifact.Url ? wrong : payload));
            }, acceptDomestic: true)))
            {
                await failover.CheckAsync();
                Assert((await failover.DownloadAsync()).Status == "downloaded", "corrupt domestic download falls back and verifies GitHub");
                Assert((WindowsUpdateManifest?)failover.State.Manifest == manifest && failoverCalls.TakeLast(2).SequenceEqual(new[] { domestic.Artifact.Url, manifest.Artifact.Url }), "fallback pins same version and bytes");
            }

            var unknownCdnCalls = 0;
            using (var unknownCdn = new UpdateService(Path.Combine(directory, "domestic-redirect"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                var uri = request.RequestUri!.AbsoluteUri;
                if (uri == UpdateService.DomesticManifestUrl) return Task.FromResult(DomesticText(domesticJson));
                if (uri == UpdateService.ManifestUrl) return Task.FromResult(Text(json));
                if (uri == domestic.Artifact.Url) { var response = new HttpResponseMessage(HttpStatusCode.Found); response.Headers.Location = new("https://unknown-cdn.example/download?secret=hidden"); return Task.FromResult(response); }
                if (uri.Contains("unknown-cdn")) unknownCdnCalls++;
                return Task.FromResult(Bytes(payload));
            }, acceptDomestic: true)))
            {
                await unknownCdn.CheckAsync();
                Assert((await unknownCdn.DownloadAsync()).Status == "downloaded" && unknownCdnCalls == 0, "unproven Gitee redirect blocked before request and GitHub used");
            }

            var interruptedCalls = new List<string>(); var interruptedBodyReads = 0;
            using (var interrupted = new UpdateService(Path.Combine(directory, "domestic-body-interrupted"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                var uri = request.RequestUri!.AbsoluteUri; interruptedCalls.Add(uri);
                return Task.FromResult(uri == UpdateService.DomesticManifestUrl ? DomesticText(domesticJson) : uri == UpdateService.ManifestUrl ? Text(json)
                    : uri == domestic.Artifact.Url ? InterruptedBytes(payload, () => interruptedBodyReads++) : Bytes(payload));
            }, acceptDomestic: true)))
            {
                await interrupted.CheckAsync();
                Assert((await interrupted.DownloadAsync()).Status == "downloaded" && interruptedBodyReads == 1 && interruptedCalls.TakeLast(2).SequenceEqual(new[] { domestic.Artifact.Url, manifest.Artifact.Url }), "response body IOException falls back to verified same bytes");
                Assert(!Directory.EnumerateFiles(Path.Combine(directory, "domestic-body-interrupted"), "*.part").Any(), "interrupted domestic partial removed before fallback completes");
            }

            var diskFailurePath = Path.Combine(directory, "cache-is-a-file"); await File.WriteAllTextAsync(diskFailurePath, "controlled file");
            var diskFailureArtifactCalls = 0;
            using (var diskFailure = new UpdateService(diskFailurePath, (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                var uri = request.RequestUri!.AbsoluteUri;
                if (uri == UpdateService.DomesticManifestUrl) return Task.FromResult(DomesticText(domesticJson));
                if (uri == UpdateService.ManifestUrl) return Task.FromResult(Text(json));
                diskFailureArtifactCalls++; return Task.FromResult(Bytes(payload));
            }, acceptDomestic: true)))
            {
                await diskFailure.CheckAsync();
                Assert((await diskFailure.DownloadAsync()).Status == "error" && diskFailureArtifactCalls == 0, "local disk IO does not initiate provider fallback");
                Assert(await File.ReadAllTextAsync(diskFailurePath) == "controlled file", "disk failure preserves unrelated cache-path file");
            }

            using (var offlineGitHub = new UpdateService(Path.Combine(directory, "github-offline"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) =>
            {
                if (request.RequestUri!.AbsoluteUri == UpdateService.ManifestUrl) throw new HttpRequestException("controlled offline");
                return Task.FromResult(request.RequestUri.AbsoluteUri == UpdateService.DomesticManifestUrl ? DomesticText(domesticJson) : Bytes(payload));
            }, acceptDomestic: true)))
                Assert((WindowsUpdateManifest?)(await offlineGitHub.CheckAsync()).Manifest == domestic && (await offlineGitHub.DownloadAsync()).Status == "downloaded", "valid domestic source works with GitHub unavailable");

            using (var staleMirror = new UpdateService(Path.Combine(directory, "stale-mirror"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) => Task.FromResult(request.RequestUri!.AbsoluteUri == UpdateService.DomesticManifestUrl ? DomesticText(JsonSerializer.Serialize(Domestic(Manifest("0.5.0", payload)))) : Text(json)), acceptDomestic: true)))
                Assert((WindowsUpdateManifest?)(await staleMirror.CheckAsync()).Manifest == manifest, "stale domestic mirror cannot hide newer GitHub version");

            using (var conflict = new UpdateService(Path.Combine(directory, "conflict"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((request, _) => Task.FromResult(request.RequestUri!.AbsoluteUri == UpdateService.DomesticManifestUrl ? DomesticText(JsonSerializer.Serialize(domestic with { Artifact = domestic.Artifact with { Sha256 = new string('a', 64) } })) : Text(json)), acceptDomestic: true)))
                Assert((await conflict.CheckAsync()).Status == "error" && conflict.State.Error!.Contains("不一致"), "same-version providers must agree on immutable bytes");

            var offered = manifest;
            using (var monotonic = new UpdateService(Path.Combine(directory, "monotonic"), (_, _) => throw new Exception("not authorized"), "0.5.0", true, new ControlledHandler((_, _) => Task.FromResult(Text(JsonSerializer.Serialize(offered))))))
            {
                await monotonic.CheckAsync(); offered = Manifest("0.5.0", payload);
                Assert(((await monotonic.CheckAsync()).Manifest as WindowsUpdateManifest)?.Version == "0.5.1", "mirror rollback retains highest verified offer this session");
                offered = manifest with { Artifact = manifest.Artifact with { Sha256 = new string('b', 64) } };
                Assert((await monotonic.CheckAsync()).Status == "error" && monotonic.State.Error!.Contains("不一致"), "same version replacement refused across checks");
            }
            Assert(!Directory.EnumerateFiles(directory, "*.part", SearchOption.AllDirectories).Any(), "all partial files cleaned");
            Console.WriteLine($"{checks} native update checks passed using controlled responses; no update was launched.");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static WindowsUpdateManifest Manifest(string version, byte[] payload) => new(1, "windows", version, new(UpdateService.ArtifactUrl(version), Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant(), payload.Length), UpdateService.ReleaseNotesUrl(version), "受控更新测试", "2026-10-11T12:00:00.000Z");
    private static WindowsUpdateManifest Domestic(WindowsUpdateManifest manifest) => manifest with { SchemaVersion = 2, Provider = "gitee", Source = new(12345, 67890, $"Yuyin-{manifest.Version}-Setup.exe"), Artifact = manifest.Artifact with { Url = UpdateService.DomesticArtifactUrl(12345, 67890) }, ReleaseNotesUrl = UpdateService.DomesticReleaseNotesUrl(manifest.Version) };
    private static HttpResponseMessage Text(string value) => new(HttpStatusCode.OK) { Content = new StringContent(value, Encoding.UTF8, "application/json") };
    private static object Contents(string value) => new { type = "file", encoding = "base64", path = "updates/domestic.json", name = "domestic.json", size = Encoding.UTF8.GetByteCount(value), content = Convert.ToBase64String(Encoding.UTF8.GetBytes(value)) };
    private static HttpResponseMessage DomesticText(string value) => Text(JsonSerializer.Serialize(Contents(value)));
    private static HttpResponseMessage Redirect(string location) { var response = new HttpResponseMessage(HttpStatusCode.Found); response.Headers.Location = new(location); return response; }
    private static HttpResponseMessage Bytes(byte[] value) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(value) };
    private static HttpResponseMessage InterruptedBytes(byte[] payload, Action interrupted)
    {
        var content = new StreamContent(new InterruptedBodyStream(payload[..8], interrupted));
        content.Headers.ContentLength = payload.Length; // The declared size is valid; the body itself must fail after its first chunk.
        return new(HttpStatusCode.OK) { Content = content };
    }
    private sealed class InterruptedBodyStream(byte[] prefix, Action interrupted) : MemoryStream(prefix)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Position < Length) return base.ReadAsync(buffer, cancellationToken);
            interrupted(); return ValueTask.FromException<int>(new IOException("controlled response body interruption"));
        }
    }
    private sealed class ControlledHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> response, bool acceptDomestic = false) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => !acceptDomestic && request.RequestUri!.AbsoluteUri == UpdateService.DomesticManifestUrl ? Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)) : response(request, cancellationToken);
    }
}
