using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Yuyin.WindowsHost;

internal static class NativePlayerTests
{
    [STAThread]
    private static int Main()
    {
        var result = 1;
        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        application.Startup += async (_, _) =>
        {
            try { await RunAsync(application); result = 0; }
            catch (Exception error) { Console.Error.WriteLine(error); }
            finally { application.Shutdown(); }
        };
        application.Run();
        return result;
    }

    private static async Task RunAsync(Application application)
    {
        var directory = Path.Combine(Path.GetTempPath(), "yuyin-native-player-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        Console.WriteLine("Native player tests use a new temporary WebView2 profile and controlled silent media.");
        var environment = await CoreWebView2Environment.CreateAsync(null, directory,
            new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required" });
        var player = new PlayerHost(environment, application.Dispatcher);
        var checks = 0;
        void Assert(bool result, string name) { if (!result) throw new Exception("FAIL native player: " + name); checks++; }
        var initialize = typeof(PlayerHost).GetMethod("EnsureAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        await (Task)initialize.Invoke(player, null)!;
        var core = (CoreWebView2)typeof(PlayerHost).GetField("_core", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(player)!;
        var window = (Window)typeof(PlayerHost).GetField("_window", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(player)!;
        var requests = 0;
        var ended = 0;
        var statuses = new List<PlaybackStatus>();
        player.StatusChanged += status => statuses.Add(status);
        player.Ended += () => ended++;
        var wave = SilentWave(45);
        var html = ControlledHTML(wave);
        var streams = new List<Stream>();
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        void Respond(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            requests++;
            var bytes = e.ResourceContext == CoreWebView2WebResourceContext.Document ? Encoding.UTF8.GetBytes(html) : [];
            var stream = new MemoryStream(bytes); streams.Add(stream);
            e.Response = environment.CreateWebResourceResponse(stream, 200, "OK", "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
        }
        core.WebResourceRequested += Respond;
        var song = new Song("BV1Qa0000001", "BV1Qa0000001", "虚构原生播放测试", "Controlled", "", 45, 0, "bilibili", "https://www.bilibili.com/video/BV1Qa0000001/");
        try
        {
            var status = await player.PlayAsync(song).WaitAsync(TimeSpan.FromSeconds(30));
            Assert(status.State == "playing" && status.CurrentTime < 2, "actual native media starts at zero");
            Assert(!core.IsMuted, "output unmuted only after confirmed playback");
            Assert(window.IsVisible && window.Left < -1000 && !window.ShowInTaskbar, "source remains a shown off-screen native surface");
            var start = player.Status.CurrentTime;
            await Task.Delay(1400);
            Assert(player.Status.CurrentTime > start + .9, "audio clock advances with source off screen");
            await player.ShowSourceAsync();
            Assert(window.Left >= SystemParameters.WorkArea.Left && window.ShowInTaskbar, "source window can be brought on screen");
            window.Close();
            Assert(window.IsVisible && window.Left < -1000 && !window.ShowInTaskbar, "source close hides it without destroying media");
            start = player.Status.CurrentTime;
            await Task.Delay(1100);
            Assert(player.Status.CurrentTime > start + .65, "native playback continues after source close");

            var beforeMVRequests = requests;
            var beforeMV = player.Status.CurrentTime;
            await core.ExecuteScriptAsync("document.querySelector('video').__fixtureIdentity='same-audio-source'; true");
            await player.ShowMVAsync();
            Assert(await BooleanAsync(core, "Boolean(document.querySelector('.bpx-state-web'))") && window.WindowState == WindowState.Normal && window.WindowStyle == WindowStyle.SingleBorderWindow, "MV uses webpage fullscreen inside the existing normal native window");
            Assert(ReferenceEquals(core, typeof(PlayerHost).GetField("_core", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(player)) && requests == beforeMVRequests && await BooleanAsync(core, "document.querySelector('video').__fixtureIdentity==='same-audio-source' && document.querySelectorAll('video').length===1"), "MV reuses the exact native core/media without document load or second source");
            await Task.Delay(700);
            Assert(player.Status.CurrentTime > beforeMV + .45, "MV presentation preserves and advances listening position");
            await player.ShowMVAsync();
            Assert(await BooleanAsync(core, "window.__mvButtonClicks===1 && Boolean(document.querySelector('.bpx-state-web'))"), "opening already-full MV does not toggle back to normal page");
            // Deliver an already-exited older native-fullscreen event after a
            // new webpage-full presentation, without altering current media.
            var mvRequest = (long)typeof(PlayerHost).GetField("_mvRequest", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(player)!;
            typeof(PlayerHost).GetField("_nativeFullscreenRequest", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(player, mvRequest - 1);
            typeof(PlayerHost).GetMethod("Source_ContainsFullScreenElementChanged", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(player, new object[] { core, EventArgs.Empty });
            Assert(window.Left >= SystemParameters.WorkArea.Left && window.ShowInTaskbar && await BooleanAsync(core, "Boolean(document.querySelector('.bpx-state-web'))"), "late native fullscreen exit from an older request cannot hide newer MV");
            window.Close();
            await WaitAsync(() => window.Left < -1000 && !window.ShowInTaskbar, TimeSpan.FromSeconds(3));
            await WaitBooleanAsync(core, "!document.querySelector('.bpx-state-web')", TimeSpan.FromSeconds(3));
            beforeMV = player.Status.CurrentTime; await Task.Delay(900);
            Assert(player.Status.State == "playing" && player.Status.CurrentTime > beforeMV + .6 && !core.IsMuted, "closing MV exits page mode and continues the same background audio");

            await player.ShowMVAsync();
            // A rejected navigation must leave the current presentation alone.
            // The target is blocked before a request; all source traffic is
            // still intercepted by the controlled response handler above.
            core.Navigate("https://example.invalid/not-a-source");
            await Task.Delay(180);
            Assert(core.Source.Contains(song.Bvid, StringComparison.Ordinal) && await BooleanAsync(core, "Boolean(document.querySelector('.bpx-state-web'))"), "rejected external navigation cannot cancel active MV presentation");
            await core.ExecuteScriptAsync("document.querySelector('.bpx-player-ctrl-web').click(); true");
            await WaitAsync(() => window.Left < -1000, TimeSpan.FromSeconds(3));
            Assert(player.Status.State == "playing" && !core.IsMuted, "source webpage fullscreen exit returns only an active MV session to background");

            await player.ShowMVAsync();
            await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", "{\"expression\":\"document.querySelector('.bpx-player-container').requestFullscreen()\",\"userGesture\":true}");
            await WaitAsync(() => core.ContainsFullScreenElement, TimeSpan.FromSeconds(3));
            Assert(window.WindowState == WindowState.Maximized && window.WindowStyle == WindowStyle.SingleBorderWindow, "native page fullscreen uses a closable maximized WPF window");
            await core.ExecuteScriptAsync("document.exitFullscreen(); true");
            await WaitAsync(() => !core.ContainsFullScreenElement && window.Left < -1000, TimeSpan.FromSeconds(3));
            Assert(player.Status.State == "playing" && !core.IsMuted, "leaving native fullscreen from MV returns to uninterrupted background audio");

            await player.PauseAsync();
            var paused = player.Status.CurrentTime;
            await Task.Delay(800);
            Assert(player.Status.State == "paused" && Math.Abs(player.Status.CurrentTime - paused) < .15 && core.IsMuted, "pause stops both native clock and output");
            await player.ShowMVAsync();
            await Task.Delay(220);
            Assert(player.Status.State == "paused" && Math.Abs(player.Status.CurrentTime - paused) < .15 && core.IsMuted, "viewing a paused MV never starts playback or resets position");
            window.Close();
            await WaitBooleanAsync(core, "!document.querySelector('.bpx-state-web')", TimeSpan.FromSeconds(3));
            await core.ExecuteScriptAsync("window.__fixtureVideo=document.querySelector('video'); window.__fixtureVideo.remove(); const v=document.createElement('p'); v.id='verification'; v.textContent='安全验证'; document.body.appendChild(v); true");
            try { await player.ShowMVAsync(); throw new Exception("FAIL native player: verification page unexpectedly entered MV"); }
            catch (InvalidOperationException error) when (error.Message.Contains("安全验证", StringComparison.Ordinal)) { checks++; }
            Assert(window.Left >= SystemParameters.WorkArea.Left && window.ShowInTaskbar && window.Title == "Bilibili · 音频来源", "unready/verification MV keeps a usable normal source window");
            await core.ExecuteScriptAsync("document.getElementById('verification').remove(); document.querySelector('.bpx-player-video-wrap').appendChild(window.__fixtureVideo); true");
            window.Close();
            await player.ResumeAsync().WaitAsync(TimeSpan.FromSeconds(15));
            await Task.Delay(1000);
            Assert(player.Status.State == "playing" && player.Status.CurrentTime > paused + .65, "resume preserves and advances native clock");

            await player.PlayAsync(song).WaitAsync(TimeSpan.FromSeconds(20));
            await Task.Delay(10500);
            var trusted = player.Status.CurrentTime;
            Assert(trusted >= 10, "native guard remains active past original eight-second boundary");
            await core.ExecuteScriptAsync("document.querySelector('video').currentTime = 30; true");
            await Task.Delay(350);
            Assert(player.Status.CurrentTime > trusted - .25 && player.Status.CurrentTime < trusted + 1.5, "late native source restore rejected at trusted listening clock");
            var native = await MediaAsync(core);
            Assert(Math.Abs(native.CurrentTime - player.Status.CurrentTime) < .4, "app and source clocks remain synchronized after correction");
            Assert(statuses.All(value => value.CurrentTime < 29), "no transient restored position published");
            await player.SeekAsync(17);
            Assert(Math.Abs(player.Status.CurrentTime - 17) < .4, "explicit seek takes over native clock");
            await core.ExecuteScriptAsync("document.querySelector('video').currentTime = 22; true");
            await Task.Delay(350);
            Assert(player.Status.CurrentTime >= 22 && player.Status.CurrentTime < 24, "history guard released only after app seek");
            await player.SetVolumeAsync(.22);
            native = await MediaAsync(core);
            Assert(Math.Abs(native.Volume - .22) < .001, "native volume matches application setting");

            var first = player.PlayAsync(song);
            var second = player.PlayAsync(song with { Id = "BV1Qa0000002", Bvid = "BV1Qa0000002", Url = "https://www.bilibili.com/video/BV1Qa0000002/" });
            try { await first; throw new Exception("FAIL native player: superseded selection did not cancel"); }
            catch (InvalidOperationException error) when (error.Message.Contains("已切换")) { checks++; }
            var selected = await second.WaitAsync(TimeSpan.FromSeconds(20));
            Assert(selected.State == "playing" && selected.Song?.Bvid == "BV1Qa0000002" && selected.CurrentTime < 2, "only final rapid selection plays from zero");
            await player.SeekAsync(44.5);
            await WaitAsync(() => player.Status.State == "ended", TimeSpan.FromSeconds(5));
            await Task.Delay(350);
            Assert(ended == 1 && core.IsMuted, "native ended emitted once and output stops");
            Assert(requests > 0, "all source documents served by controlled response handler");
            if (Environment.GetEnvironmentVariable("YUYIN_NATIVE_MV_MANUAL_QA") == "1")
            {
                // Explicit test-only gate: the root agent targets this exact
                // controlled source window with actual native mouse/keyboard.
                // There is no production automation or real user profile here.
                html = ControlledHTML(SilentWave(420));
                await player.PlayAsync(song with { Duration = 420 }).WaitAsync(TimeSpan.FromSeconds(20));
                foreach (var stage in new[] { "Escape", "Close", "Minimize" })
                {
                    await player.ShowMVAsync();
                    Console.WriteLine($"MANUAL_MV_READY {stage}: title={window.Title}; profile={directory}; time={player.Status.CurrentTime:F2}");
                    await WaitAsync(() => window.Left < -1000 && !window.ShowInTaskbar, TimeSpan.FromSeconds(120));
                    var backgroundAt = player.Status.CurrentTime; await Task.Delay(1100);
                    Assert(player.Status.State == "playing" && player.Status.CurrentTime > backgroundAt + .65 && !core.IsMuted, $"actual manual {stage} preserves advancing background playback");
                    await WaitBooleanAsync(core, "!document.querySelector('.bpx-state-web') && !document.fullscreenElement", TimeSpan.FromSeconds(3));
                    Console.WriteLine($"MANUAL_MV_PASSED {stage}: same source continues at {player.Status.CurrentTime:F2}");
                }
            }
            core.WebResourceRequested -= Respond;
            await player.DisposeAsync();
            Assert(!window.IsVisible && application.Windows.Count == 0, "dispose destroys source window and WebView2");
            await Task.Delay(250);
            Console.WriteLine($"{checks} native WPF + WebView2 media checks passed using silent controlled data; no Bilibili video or real profile was read.");
        }
        finally
        {
            await player.DisposeAsync();
            foreach (var stream in streams) stream.Dispose();
            // The browser process may release its fresh profile shortly after
            // control disposal; remove only this exact randomly created path.
            for (var attempt = 0; attempt < 12; attempt++)
            {
                try { Directory.Delete(directory, recursive: true); break; }
                catch (IOException) { await Task.Delay(250); }
                catch (UnauthorizedAccessException) { await Task.Delay(250); }
            }
        }
    }

    private static async Task<(double CurrentTime, double Volume)> MediaAsync(CoreWebView2 core)
    {
        using var document = JsonDocument.Parse(await core.ExecuteScriptAsync("(() => { const v = document.querySelector('video'); return { currentTime: v.currentTime, volume: v.volume }; })()"));
        return (document.RootElement.GetProperty("currentTime").GetDouble(), document.RootElement.GetProperty("volume").GetDouble());
    }

    private static async Task<bool> BooleanAsync(CoreWebView2 core, string expression) => JsonSerializer.Deserialize<bool>(await core.ExecuteScriptAsync(expression));
    private static async Task WaitBooleanAsync(CoreWebView2 core, string expression, TimeSpan timeout)
    {
        var end = DateTime.UtcNow + timeout;
        while (!await BooleanAsync(core, expression)) { if (DateTime.UtcNow >= end) throw new TimeoutException("Controlled MV page state timed out."); await Task.Delay(50); }
    }

    private static string ControlledHTML(byte[] wave) => """
        <!doctype html><meta charset=utf-8><title>Controlled MV fixture</title>
        <style>body{margin:0;background:#e8e8e8;font:16px sans-serif}.bpx-player-container{position:relative;width:640px;height:400px;margin:40px auto;background:#111;color:#fff}.bpx-player-video-wrap,video{width:100%;height:100%}.bpx-state-web{position:fixed;inset:0;width:100vw;height:100vh;margin:0}.bpx-player-control-bottom{position:absolute;bottom:16px;right:20px;display:flex;gap:12px}.bpx-player-control-bottom button{padding:12px 20px;color:#fff;background:#345446;border:1px solid #94a89d;border-radius:6px}.fixture-label{position:absolute;top:25px;left:25px;color:#ccc;pointer-events:none}</style>
        <div class='bpx-player-container' data-screen='normal'><div class='bpx-player-video-wrap'><video id='media' preload='auto' src='data:audio/wav;base64,
        """ + Convert.ToBase64String(wave) + """
        '></video></div><span class='fixture-label'>Controlled silent MV · same source video</span><div class='bpx-player-control-bottom'><button class='bpx-player-ctrl-web' title='网页全屏'>网页全屏 / 返回</button><button id='native-fullscreen'>原生全屏</button></div></div>
        <script>window.__mvButtonClicks=0; const c=document.querySelector('.bpx-player-container');document.querySelector('.bpx-player-ctrl-web').onclick=()=>{window.__mvButtonClicks++;const full=c.classList.toggle('bpx-state-web');c.dataset.screen=full?'web':'normal';};document.getElementById('native-fullscreen').onclick=()=>{if(document.fullscreenElement)document.exitFullscreen();else c.requestFullscreen();};</script>
        """;

    private static async Task WaitAsync(Func<bool> condition, TimeSpan timeout)
    {
        var end = DateTime.UtcNow + timeout;
        while (!condition()) { if (DateTime.UtcNow >= end) throw new TimeoutException("Controlled native media state timed out."); await Task.Delay(50); }
    }

    private static byte[] SilentWave(int seconds)
    {
        const int sampleRate = 8000;
        var dataSize = seconds * sampleRate * 2;
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream);
        writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + dataSize); writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        writer.Write(16); writer.Write((short)1); writer.Write((short)1); writer.Write(sampleRate); writer.Write(sampleRate * 2); writer.Write((short)2); writer.Write((short)16);
        writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(dataSize); writer.Write(new byte[dataSize]);
        return stream.ToArray();
    }
}
