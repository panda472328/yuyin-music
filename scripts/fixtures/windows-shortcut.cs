using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

// Test-only Unicode shortcut fixture. Never resolves a link or uses real shell folders.
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class ShellLink { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLinkW
{
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int capacity, IntPtr data, uint flags);
    void GetIDList(out IntPtr id);
    void SetIDList(IntPtr id);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int capacity);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int capacity);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int capacity);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetHotkey(out ushort value);
    void SetHotkey(ushort value);
    void GetShowCmd(out int value);
    void SetShowCmd(int value);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int capacity, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
    void Resolve(IntPtr window, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
}

class ShortcutFixture
{
    static string ScopedPath(string root, string value)
    {
        if (!Path.IsPathRooted(value)) throw new ArgumentException("Absolute fixture path required.");
        var full = Path.GetFullPath(value);
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Shortcut fixture path must stay inside its QA directory.");
        return full;
    }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length != 3 && args.Length != 4) throw new ArgumentException("Invalid fixture command.");
            var root = Path.GetFullPath(args[1]).TrimEnd(Path.DirectorySeparatorChar);
            if (!Path.GetFileName(root).StartsWith("webview2-installer-flow-", StringComparison.Ordinal) ||
                Path.GetFileName(Path.GetDirectoryName(root)) != ".qa")
                throw new ArgumentException("Isolated installer QA root required.");
            var file = ScopedPath(root, args[2]);
            if (!file.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Shortcut file required.");
            object instance = new ShellLink();
            try
            {
                var link = (IShellLinkW)instance;
                var persist = (IPersistFile)instance;
                if (args[0] == "write" && args.Length == 4)
                {
                    link.SetPath(ScopedPath(root, args[3]));
                    link.SetDescription("Controlled installer regression fixture");
                    persist.Save(file, true);
                }
                else if (args[0] == "read" && args.Length == 3)
                {
                    persist.Load(file, 0);
                    var target = new StringBuilder(32768);
                    link.GetPath(target, target.Capacity, IntPtr.Zero, 4); // SLGP_RAWPATH; no Resolve.
                    Console.WriteLine(ScopedPath(root, target.ToString()));
                }
                else throw new ArgumentException("Invalid fixture command.");
            }
            finally { Marshal.FinalReleaseComObject(instance); }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
