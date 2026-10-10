using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Party P2P Updater")]
[assembly: System.Reflection.AssemblyProduct("Party P2P")]
[assembly: System.Reflection.AssemblyCompany("Party P2P")]
[assembly: System.Reflection.AssemblyVersion("2.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("2.0.0.0")]

namespace PartyP2P.Updater
{
    internal sealed class UpdateJob
    {
        public string TargetPath { get; set; }
        public int ParentPid { get; set; }
        public string DownloadUrl { get; set; }
        public string AssetDigest { get; set; }
        public string Version { get; set; }
        public string ReadyPath { get; set; }
        public string Mode { get; set; }
        public string JobPath { get; set; }
    }

    internal static class Log
    {
        private static readonly object Sync = new object();
        internal static readonly string FilePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "updater.log");

        internal static void Write(string message)
        {
            try
            {
                lock (Sync)
                    File.AppendAllText(FilePath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + message + Environment.NewLine);
            }
            catch { }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            if (Array.Exists(args, delegate(string value) { return String.Equals(value, "--self-test", StringComparison.OrdinalIgnoreCase); }))
            {
                try { UpdaterSelfTest.Run(); Environment.ExitCode = 0; }
                catch (Exception error) { Log.Write("Self-test failed: " + error); Environment.ExitCode = 1; }
                return;
            }
            bool ownsMutex;
            using (var mutex = new Mutex(true, "Local\\PartyP2P.Updater", out ownsMutex))
            {
                if (!ownsMutex) return;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                UpdaterForm form = null;
                Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs e)
                {
                    Log.Write("ThreadException: " + e.Exception);
                    if (form != null) form.ShowFailure(e.Exception.Message);
                };
                AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
                {
                    Log.Write("UnhandledException: " + e.ExceptionObject);
                };

                try
                {
                    var job = ReadJob(args);
                    form = new UpdaterForm(job);
                    Application.Run(form);
                }
                catch (Exception error)
                {
                    Log.Write("Startup failure: " + error);
                    MessageBox.Show(error.Message, "Party P2P — Atualização", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private static UpdateJob ReadJob(string[] args)
        {
            string jobPath = null;
            for (var i = 0; i + 1 < args.Length; i++)
                if (String.Equals(args[i], "--job", StringComparison.OrdinalIgnoreCase)) jobPath = args[i + 1];
            if (String.IsNullOrWhiteSpace(jobPath) || !Path.IsPathRooted(jobPath) || !File.Exists(jobPath))
                throw new InvalidOperationException("O arquivo de trabalho do atualizador não foi encontrado.");

            var serializer = new JavaScriptSerializer();
            var job = serializer.Deserialize<UpdateJob>(File.ReadAllText(jobPath));
            if (job == null) throw new InvalidOperationException("O arquivo de trabalho do atualizador é inválido.");
            job.JobPath = jobPath;
            return job;
        }
    }

    internal sealed class UpdaterForm : Form
    {
        private readonly UpdateJob job;
        private readonly Label status;
        private readonly Label percent;
        private readonly ProgressBar progress;
        private readonly Button closeButton;
        private readonly Button logButton;
        private bool running = true;
        private string stagedFile;
        private string preparedFile;

        internal UpdaterForm(UpdateJob job)
        {
            this.job = job;
            Text = "Party P2P — Atualização";
            ClientSize = new Size(470, 330);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.FromArgb(11, 13, 17);
            ForeColor = Color.FromArgb(238, 240, 246);
            Font = new Font("Segoe UI", 10f);

            var mark = NewLabel("P", 34, 30, 34, 34, Color.White, 14f, FontStyle.Bold);
            mark.BackColor = Color.FromArgb(113, 102, 232);
            mark.TextAlign = ContentAlignment.MiddleCenter;
            Controls.Add(mark);
            Controls.Add(NewLabel("Party P2P", 78, 34, 180, 28, ForeColor, 14f, FontStyle.Bold));
            Controls.Add(NewLabel("ATUALIZAÇÃO", 36, 105, 300, 22, Color.FromArgb(139, 133, 255), 9f, FontStyle.Bold));
            Controls.Add(NewLabel("Preparando a nova versão", 34, 130, 395, 34, ForeColor, 16f, FontStyle.Bold));

            status = NewLabel("Iniciando atualizador com permissão de administrador…", 36, 173, 400, 42, Color.FromArgb(147, 155, 170), 10f, FontStyle.Regular);
            Controls.Add(status);
            progress = new ProgressBar { Location = new Point(36, 225), Size = new Size(315, 10), Style = ProgressBarStyle.Marquee };
            Controls.Add(progress);
            percent = NewLabel("Aguarde", 360, 218, 75, 25, Color.FromArgb(147, 155, 170), 9f, FontStyle.Regular);
            percent.TextAlign = ContentAlignment.MiddleRight;
            Controls.Add(percent);
            Controls.Add(NewLabel("Mantenha esta janela aberta. O Party P2P será reiniciado automaticamente.", 36, 266, 395, 28, Color.FromArgb(147, 155, 170), 8.5f, FontStyle.Regular));
            logButton = new Button { Text = "Abrir log", Location = new Point(248, 291), Size = new Size(96, 28), Visible = false };
            logButton.Click += delegate { try { Process.Start(new ProcessStartInfo(Log.FilePath) { UseShellExecute = true }); } catch { } };
            Controls.Add(logButton);
            closeButton = new Button { Text = "Fechar", Location = new Point(350, 291), Size = new Size(84, 28), Visible = false };
            closeButton.Click += delegate { Close(); };
            Controls.Add(closeButton);

            Shown += async delegate { await RunUpdateAsync(); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) { if (running && !closeButton.Visible) e.Cancel = true; };
        }

        private Label NewLabel(string text, int x, int y, int width, int height, Color color, float size, FontStyle style)
        {
            return new Label { Text = text, Location = new Point(x, y), Size = new Size(width, height), ForeColor = color, Font = new Font("Segoe UI", size, style) };
        }

        private void SetStatus(string text, int? value)
        {
            status.Text = text;
            if (value.HasValue)
            {
                progress.Style = ProgressBarStyle.Continuous;
                progress.Value = Math.Max(0, Math.Min(100, value.Value));
                percent.Text = value.Value + "%";
            }
            else
            {
                progress.Style = ProgressBarStyle.Marquee;
                percent.Text = "Aguarde";
            }
        }

        internal void ShowFailure(string message)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(ShowFailure), message); return; }
            running = false;
            status.ForeColor = Color.FromArgb(255, 158, 172);
            status.Text = message;
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = 0;
            percent.Text = "Falhou";
            logButton.Visible = true;
            closeButton.Visible = true;
        }

        private async Task RunUpdateAsync()
        {
            try
            {
                ValidateJob();
                File.WriteAllText(job.ReadyPath, Process.GetCurrentProcess().Id.ToString());
                var target = Path.GetFullPath(job.TargetPath);
                Log.Write("Starting " + job.Mode + " update to " + job.Version + ". Target=" + target + "; ParentPid=" + job.ParentPid);

                SetStatus("Baixando a versão " + job.Version + "…", 0);
                stagedFile = await DownloadAsync(job.DownloadUrl);
                SetStatus("Verificando a integridade do arquivo…", null);
                VerifyDownload(stagedFile, job.AssetDigest);

                if (String.Equals(job.Mode, "portable", StringComparison.OrdinalIgnoreCase))
                {
                    preparedFile = target + ".party-p2p-new";
                    DeleteIfExists(preparedFile);
                    File.Copy(stagedFile, preparedFile, true);
                    await StopOriginalAsync();
                    SetStatus("Substituindo o executável anterior…", null);
                    await WaitUntilReplaceableAsync(target, TimeSpan.FromSeconds(90));
                    ReplaceAtomically(preparedFile, target);
                }
                else
                {
                    await StopOriginalAsync();
                    SetStatus("Instalando a nova versão…", null);
                    RunInstaller(stagedFile);
                }

                SetStatus("Atualização concluída. Abrindo Party P2P…", 100);
                RestartAndCommit(target);
                Cleanup(true);
                await Task.Delay(1000);
                running = false;
                Close();
            }
            catch (Exception error)
            {
                Log.Write("Update failed: " + error);
                Cleanup(false);
                ShowFailure("Não foi possível concluir: " + error.Message);
            }
        }

        private void ValidateJob()
        {
            if (job.ParentPid <= 0 || String.IsNullOrWhiteSpace(job.TargetPath) || !Path.IsPathRooted(job.TargetPath))
                throw new InvalidOperationException("O destino da atualização é inválido.");
            if (!File.Exists(job.TargetPath) || !String.Equals(Path.GetExtension(job.TargetPath), ".exe", StringComparison.OrdinalIgnoreCase))
                throw new FileNotFoundException("O executável atual não foi localizado.", job.TargetPath);
            var targetInfo = FileVersionInfo.GetVersionInfo(job.TargetPath);
            if (!String.Equals(targetInfo.ProductName, "Party P2P", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("O destino informado não pertence ao Party P2P.");
            if (!String.Equals(job.Mode, "portable", StringComparison.OrdinalIgnoreCase) && !String.Equals(job.Mode, "installer", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("O modo de atualização é inválido.");
            if (String.IsNullOrWhiteSpace(job.ReadyPath) || !Path.IsPathRooted(job.ReadyPath))
                throw new InvalidOperationException("O sinal de inicialização é inválido.");
            var updaterFolder = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
            var readyFolder = Path.GetFullPath(Path.GetDirectoryName(job.ReadyPath)).TrimEnd(Path.DirectorySeparatorChar);
            var jobFolder = Path.GetFullPath(Path.GetDirectoryName(job.JobPath)).TrimEnd(Path.DirectorySeparatorChar);
            if (!String.Equals(updaterFolder, readyFolder, StringComparison.OrdinalIgnoreCase)
                || !String.Equals(updaterFolder, jobFolder, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Os arquivos de controle do atualizador estão fora da pasta permitida.");
            var uri = new Uri(job.DownloadUrl);
            if (!String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                || !String.Equals(uri.Host, "github.com", StringComparison.OrdinalIgnoreCase)
                || !uri.AbsolutePath.StartsWith("/1Eezzy/Party-P2P/releases/download/", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("A origem do download não é uma release oficial do Party P2P.");
        }

        private async Task<string> DownloadAsync(string url)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            var staging = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "staging");
            Directory.CreateDirectory(staging);
            var destination = Path.Combine(staging, "Party-P2P-" + Sanitize(job.Version) + ".exe.partial");
            DeleteIfExists(destination);
            using (var handler = new HttpClientHandler { AllowAutoRedirect = true })
            using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(10) })
            {
                client.DefaultRequestHeaders.UserAgent.ParseAdd("Party-P2P-Updater/2.0");
                using (var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead))
                {
                    response.EnsureSuccessStatusCode();
                    ValidateFinalDownloadHost(response.RequestMessage.RequestUri);
                    var total = response.Content.Headers.ContentLength;
                    if (total.HasValue && total.Value > 512L * 1024L * 1024L) throw new InvalidDataException("O arquivo da atualização é grande demais.");
                    using (var input = await response.Content.ReadAsStreamAsync())
                    using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, true))
                    {
                        var buffer = new byte[81920];
                        long received = 0;
                        int read;
                        while ((read = await input.ReadAsync(buffer, 0, buffer.Length)) > 0)
                        {
                            received += read;
                            if (received > 512L * 1024L * 1024L) throw new InvalidDataException("O arquivo da atualização é grande demais.");
                            await output.WriteAsync(buffer, 0, read);
                            if (total.HasValue && total.Value > 0)
                            {
                                var value = (int)Math.Min(100, received * 100L / total.Value);
                                SetStatus("Baixando a versão " + job.Version + ": " + value + "%", value);
                            }
                        }
                        await output.FlushAsync();
                    }
                }
            }
            return destination;
        }

        private static void ValidateFinalDownloadHost(Uri uri)
        {
            var host = uri.Host.ToLowerInvariant();
            if (host != "github.com" && host != "objects.githubusercontent.com" && host != "release-assets.githubusercontent.com")
                throw new InvalidOperationException("O GitHub redirecionou o download para uma origem não confiável.");
        }

        private static void VerifyDownload(string file, string digest)
        {
            using (var stream = File.OpenRead(file))
            {
                if (stream.ReadByte() != 0x4d || stream.ReadByte() != 0x5a)
                    throw new InvalidDataException("O arquivo baixado não é um executável Windows válido.");
            }
            if (!String.IsNullOrWhiteSpace(digest) && digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
            {
                string actual;
                using (var stream = File.OpenRead(file))
                using (var sha = SHA256.Create()) actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                var expected = digest.Substring(7).Trim().ToLowerInvariant();
                if (!CryptographicEquals(actual, expected)) throw new InvalidDataException("A verificação SHA-256 da atualização falhou.");
            }
        }

        private async Task StopOriginalAsync()
        {
            SetStatus("Encerrando a versão anterior…", null);
            for (var i = 0; i < 40 && ProcessExists(job.ParentPid); i++) await Task.Delay(125);
            if (ProcessExists(job.ParentPid))
            {
                var taskkill = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
                using (var process = Process.Start(new ProcessStartInfo(taskkill, "/PID " + job.ParentPid + " /T /F") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden }))
                {
                    if (process != null) process.WaitForExit(15000);
                }
            }
            for (var i = 0; i < 160 && ProcessExists(job.ParentPid); i++) await Task.Delay(125);
            if (ProcessExists(job.ParentPid)) throw new InvalidOperationException("A versão anterior não encerrou completamente.");
        }

        private static async Task WaitUntilReplaceableAsync(string target, TimeSpan timeout)
        {
            var end = DateTime.UtcNow + timeout;
            Exception last = null;
            while (DateTime.UtcNow < end)
            {
                var available = false;
                try
                {
                    using (File.Open(target, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                    available = true;
                }
                catch (Exception error) { last = error; }
                if (available) return;
                await Task.Delay(250);
            }
            throw new IOException("O launcher portátil ainda está usando o executável após " + (int)timeout.TotalSeconds + " segundos.", last);
        }

        internal static void ReplaceAtomically(string prepared, string target)
        {
            var backup = target + ".party-p2p-backup";
            DeleteIfExists(backup);
            try
            {
                File.Replace(prepared, target, backup, true);
            }
            catch (PlatformNotSupportedException) { ReplaceWithRollback(prepared, target, backup); }
            catch (IOException) { ReplaceWithRollback(prepared, target, backup); }
            catch (UnauthorizedAccessException) { ReplaceWithRollback(prepared, target, backup); }
            if (!File.Exists(target) || new FileInfo(target).Length < 2) throw new IOException("O novo executável não foi gravado corretamente.");
            Log.Write("Atomic replacement completed. Backup=" + backup);
        }

        private static void ReplaceWithRollback(string prepared, string target, string backup)
        {
            try
            {
                File.Move(target, backup);
                File.Move(prepared, target);
            }
            catch
            {
                if (!File.Exists(target) && File.Exists(backup)) File.Move(backup, target);
                throw;
            }
        }

        private static void RunInstaller(string installer)
        {
            using (var process = Process.Start(new ProcessStartInfo(installer, "/S") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden }))
            {
                if (process == null) throw new InvalidOperationException("O instalador não pôde ser iniciado.");
                process.WaitForExit();
                if (process.ExitCode != 0) throw new InvalidOperationException("O instalador terminou com código " + process.ExitCode + ".");
            }
        }

        private static void RestartAndCommit(string target)
        {
            var backup = target + ".party-p2p-backup";
            try
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
                DeleteIfExists(backup);
            }
            catch
            {
                if (File.Exists(backup))
                {
                    DeleteIfExists(target);
                    File.Move(backup, target);
                }
                throw;
            }
        }

        private void Cleanup(bool success)
        {
            DeleteIfExists(stagedFile);
            DeleteIfExists(preparedFile);
            if (success) { DeleteIfExists(job.JobPath); DeleteIfExists(job.ReadyPath); }
        }

        private static bool ProcessExists(int pid)
        {
            try { using (var process = Process.GetProcessById(pid)) return !process.HasExited; }
            catch { return false; }
        }

        private static string Sanitize(string value)
        {
            foreach (var invalid in Path.GetInvalidFileNameChars()) value = value.Replace(invalid, '_');
            return String.IsNullOrWhiteSpace(value) ? "update" : value;
        }

        private static bool CryptographicEquals(string left, string right)
        {
            if (left.Length != right.Length) return false;
            var difference = 0;
            for (var i = 0; i < left.Length; i++) difference |= left[i] ^ right[i];
            return difference == 0;
        }

        private static void DeleteIfExists(string file)
        {
            if (String.IsNullOrWhiteSpace(file)) return;
            try { if (File.Exists(file)) File.Delete(file); }
            catch { }
        }
    }

    internal static class UpdaterSelfTest
    {
        internal static void Run()
        {
            var folder = Path.Combine(Path.GetTempPath(), "PartyP2P-updater-selftest-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            try
            {
                var target = Path.Combine(folder, "Party P2P.exe");
                var prepared = target + ".party-p2p-new";
                var oldBytes = new byte[] { 0x4d, 0x5a, 0x01 };
                var newBytes = new byte[] { 0x4d, 0x5a, 0x02, 0x03 };
                File.WriteAllBytes(target, oldBytes);
                File.WriteAllBytes(prepared, newBytes);
                UpdaterForm.ReplaceAtomically(prepared, target);
                var actual = File.ReadAllBytes(target);
                if (actual.Length != newBytes.Length || actual[2] != newBytes[2])
                    throw new InvalidOperationException("A substituição atômica não preservou o arquivo novo.");
                var backup = File.ReadAllBytes(target + ".party-p2p-backup");
                if (backup.Length != oldBytes.Length || backup[2] != oldBytes[2])
                    throw new InvalidOperationException("O backup da versão anterior não foi criado corretamente.");
            }
            finally
            {
                try { Directory.Delete(folder, true); } catch { }
            }
        }
    }
}
