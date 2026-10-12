using System.IO;
using Yuyin.WindowsHost;

/// Explicit opt-in public-network probe. Never starts or installs the EXE.
internal static class LiveUpdateProbe
{
    internal static async Task RunAsync(string expectedVersion)
    {
        if (!UpdateService.IsStableVersion(expectedVersion) || UpdateService.CompareVersions(expectedVersion, "0.5.0") <= 0)
            throw new ArgumentException("A published stable version newer than the controlled 0.5.0 baseline is required.");
        var cache = Path.Combine(Path.GetTempPath(), "yuyin-public-update-probe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(cache);
        try
        {
            using var updater = new UpdateService(cache, (_, _) => throw new Exception("Live download probes never authorize installation."), "0.5.0", true);
            var state = await updater.CheckAsync();
            if (state.Status != "available" || state.Manifest is not WindowsUpdateManifest manifest || manifest.Version != expectedVersion || manifest.Provider != "gitee")
                throw new Exception("The expected public Gitee offer was not selected: " + (state.Error ?? state.Status));
            state = await updater.DownloadAsync();
            if (state.Status != "downloaded" || state.Manifest is not WindowsUpdateManifest downloaded || downloaded.Provider != "gitee" || downloaded != manifest)
                throw new Exception("The exact Gitee download was not verified; a fallback does not pass this probe: " + (state.Error ?? state.Status));
            var files = Directory.GetFiles(cache);
            if (files.Length != 1 || !await UpdateService.VerifyUpdateFileAsync(files[0], manifest))
                throw new Exception("The updater's final cached file did not independently match the public manifest.");
            Console.WriteLine($"Public native Gitee probe passed: version={manifest.Version}; bytes={manifest.Artifact.Size}; sha256={manifest.Artifact.Sha256}; no profile, cookies or installer execution.");
        }
        finally
        {
            // This method only creates and removes its own random temp cache.
            Directory.Delete(cache, recursive: true);
        }
    }
}
