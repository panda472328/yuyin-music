using System.Text.Json;

namespace Yuyin.WindowsHost;

public readonly record struct DesktopLyricsDragRect(double Left, double Top, double Width, double Height)
{
    public bool Contains(double x, double y) => x >= Left && x < Left + Width && y >= Top && y < Top + Height;
    public bool Fits(double viewportWidth, double viewportHeight) =>
        double.IsFinite(Left) && double.IsFinite(Top) && double.IsFinite(Width) && double.IsFinite(Height) &&
        Width > 0 && Height > 0 && Left >= 0 && Top >= 0 && Left + Width <= viewportWidth && Top + Height <= viewportHeight;
}

/// Validated renderer geometry used only for native hit testing.  The overlay
/// remains draggable outside the toolbar; toolbar controls remain HTCLIENT.
public sealed record DesktopLyricsDragRegions(
    double ViewportWidth, double ViewportHeight, bool ToolbarVisible,
    DesktopLyricsDragRect Toolbar, DesktopLyricsDragRect Handle)
{
    public bool IsWindowDragTarget(double xDip, double yDip, double hostWidth, double hostHeight, bool locked)
    {
        if (locked || hostWidth <= 0 || hostHeight <= 0 || xDip < 0 || yDip < 0 || xDip >= hostWidth || yDip >= hostHeight) return false;
        var x = xDip * ViewportWidth / hostWidth;
        var y = yDip * ViewportHeight / hostHeight;
        if (x < 0 || y < 0 || x >= ViewportWidth || y >= ViewportHeight) return false;
        return !ToolbarVisible || !Toolbar.Contains(x, y) || Handle.Contains(x, y);
    }

    public static DesktopLyricsDragRegions Parse(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object || !ExactFields(value, "viewportWidth", "viewportHeight", "toolbarVisible", "toolbar", "handle"))
            throw new InvalidOperationException("桌面歌词拖动区域格式不正确。");
        var viewportWidth = Number(value, "viewportWidth");
        var viewportHeight = Number(value, "viewportHeight");
        if (viewportWidth <= 0 || viewportHeight <= 0 || viewportWidth > 4096 || viewportHeight > 4096 ||
            !value.TryGetProperty("toolbarVisible", out var visible) || visible.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidOperationException("桌面歌词拖动区域无效。");
        var toolbar = Rectangle(value, "toolbar");
        var handle = Rectangle(value, "handle");
        if (!toolbar.Fits(viewportWidth, viewportHeight) || !handle.Fits(viewportWidth, viewportHeight) ||
            handle.Left < toolbar.Left || handle.Top < toolbar.Top || handle.Left + handle.Width > toolbar.Left + toolbar.Width || handle.Top + handle.Height > toolbar.Top + toolbar.Height)
            throw new InvalidOperationException("桌面歌词拖动区域超出窗口。");
        return new DesktopLyricsDragRegions(viewportWidth, viewportHeight, visible.GetBoolean(), toolbar, handle);
    }

    private static DesktopLyricsDragRect Rectangle(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Object || !ExactFields(value, "left", "top", "width", "height"))
            throw new InvalidOperationException("桌面歌词拖动区域格式不正确。");
        return new DesktopLyricsDragRect(Number(value, "left"), Number(value, "top"), Number(value, "width"), Number(value, "height"));
    }
    private static double Number(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Number &&
        field.TryGetDouble(out var number) && double.IsFinite(number) ? number : throw new InvalidOperationException("桌面歌词拖动区域数值无效。");
    private static bool ExactFields(JsonElement value, params string[] allowed)
    {
        var fields = value.EnumerateObject().Select(property => property.Name).ToArray();
        return fields.Length == allowed.Length && fields.All(name => allowed.Contains(name, StringComparer.Ordinal));
    }
}
