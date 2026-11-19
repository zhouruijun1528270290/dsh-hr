using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Media.Capture;
using Windows.Media.Capture.Frames;
using Windows.Media.MediaProperties;
using Windows.Storage.Streams;

internal static class WindowsCamera
{
    private const int PreviewWidth = 640;
    private const int FrameIntervalMs = 45;

    private static T Wait<T>(IAsyncOperation<T> operation)
    {
        while (operation.Status == AsyncStatus.Started) Thread.Sleep(1);
        return operation.GetResults();
    }

    private static void Wait(IAsyncAction operation)
    {
        while (operation.Status == AsyncStatus.Started) Thread.Sleep(1);
        operation.GetResults();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                using (var output = Console.OpenStandardOutput())
                using (var bitmap = new SoftwareBitmap(BitmapPixelFormat.Bgra8, 64, 48, BitmapAlphaMode.Ignore))
                    WriteFrame(output, bitmap);
                return 0;
            }
            int ownerId;
            if (args.Length != 1 || !Int32.TryParse(args[0], out ownerId) || ownerId < 1) return 1;
            using (var owner = Process.GetProcessById(ownerId))
            using (var output = Console.OpenStandardOutput())
                Preview(owner, output);
            return 0;
        }
        catch (UnauthorizedAccessException) { return 2; }
        catch (Exception) { return 1; }
    }

    private static void Preview(Process owner, Stream output)
    {
        var groups = Wait(MediaFrameSourceGroup.FindAllAsync());
        var group = groups.FirstOrDefault(candidate =>
            candidate.SourceInfos.Any(info => info.SourceKind == MediaFrameSourceKind.Color
                && (info.MediaStreamType == MediaStreamType.VideoPreview || info.MediaStreamType == MediaStreamType.VideoRecord)));
        if (group == null) throw new InvalidOperationException("No color video source");

        using (var capture = new MediaCapture())
        {
            Wait(capture.InitializeAsync(new MediaCaptureInitializationSettings
            {
                SourceGroup = group,
                StreamingCaptureMode = StreamingCaptureMode.Video,
                SharingMode = MediaCaptureSharingMode.SharedReadOnly,
                MemoryPreference = MediaCaptureMemoryPreference.Cpu,
            }));
            var source = capture.FrameSources.Values.Where(candidate => candidate.Info.SourceKind == MediaFrameSourceKind.Color
                    && (candidate.Info.MediaStreamType == MediaStreamType.VideoPreview || candidate.Info.MediaStreamType == MediaStreamType.VideoRecord))
                .OrderByDescending(candidate => candidate.Info.MediaStreamType == MediaStreamType.VideoPreview).First();

            using (var reader = Wait(capture.CreateFrameReaderAsync(source, MediaEncodingSubtypes.Argb32)))
            {
                reader.AcquisitionMode = MediaFrameReaderAcquisitionMode.Realtime;
                if (Wait(reader.StartAsync()) != MediaFrameReaderStartStatus.Success)
                    throw new InvalidOperationException("Camera start failed");
                var cadence = Stopwatch.StartNew();
                while (!owner.HasExited)
                {
                    cadence.Restart();
                    using (var frame = reader.TryAcquireLatestFrame())
                    {
                        if (frame != null && frame.VideoMediaFrame != null)
                            using (var bitmap = frame.VideoMediaFrame.SoftwareBitmap)
                                if (bitmap != null) WriteFrame(output, bitmap);
                    }
                    Thread.Sleep(Math.Max(1, FrameIntervalMs - (int)cadence.ElapsedMilliseconds));
                }
            }
        }
    }

    private static void WriteFrame(Stream output, SoftwareBitmap bitmap)
    {
        using (var memory = new InMemoryRandomAccessStream())
        {
            var encoder = Wait(BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, memory));
            encoder.SetSoftwareBitmap(bitmap);
            var largestDimension = Math.Max(bitmap.PixelWidth, bitmap.PixelHeight);
            if (largestDimension > PreviewWidth)
            {
                encoder.BitmapTransform.ScaledWidth = (uint)Math.Max(1, bitmap.PixelWidth * PreviewWidth / largestDimension);
                encoder.BitmapTransform.ScaledHeight = (uint)Math.Max(1, bitmap.PixelHeight * PreviewWidth / largestDimension);
            }
            Wait(encoder.FlushAsync());
            var size = (uint)memory.Size;
            if (size == 0 || size > 512 * 1024) return;
            using (var reader = new DataReader(memory.GetInputStreamAt(0)))
            {
                if (Wait<uint>(reader.LoadAsync(size)) != size) return;
                var jpeg = new byte[size];
                reader.ReadBytes(jpeg);
                var length = BitConverter.GetBytes(size);
                output.Write(length, 0, length.Length);
                output.Write(jpeg, 0, jpeg.Length);
                output.Flush();
            }
        }
    }
}
