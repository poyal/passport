using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Management.Automation;
using System.Management.Automation.Language;
using System.Management.Automation.Subsystem.Prediction;
using System.Reflection;
using System.Threading;

namespace Passport.Terminal
{
    public sealed class PathPredictor : ICommandPredictor
    {
        private readonly PathIntrinsics paths;
        private readonly MethodInfo getHistory;
        private readonly PropertyInfo commandLine;
        private volatile IReadOnlyList<string> sessionHistory = Array.Empty<string>();

        public PathPredictor(PathIntrinsics paths, Type editor)
        {
            this.paths = paths;
            getHistory = editor.GetMethod("GetHistoryItems", Type.EmptyTypes);
            commandLine = getHistory?.ReturnType.GetElementType()?.GetProperty("CommandLine");
        }

        // PSReadLine prefers plug-ins over history in InlineView. Yield to its
        // own result whenever it can complete the line, including saved history.
        private bool HasHistoryMatch(string input, CancellationToken cancellation)
        {
            bool Matches(string text) => text != null && text.Length > input.Length &&
                text.IndexOf('\n') < 0 && text.StartsWith(input, StringComparison.OrdinalIgnoreCase);
            if (sessionHistory.Any(Matches)) return true;
            if (commandLine == null) return false;
            try
            {
                if (getHistory.Invoke(null, null) is Array items)
                    for (int i = items.Length - 1; i >= 0; i--)
                        if (cancellation.IsCancellationRequested || Matches((string)commandLine.GetValue(items.GetValue(i))))
                            return true;
            }
            catch (TargetInvocationException) { } // History has not initialized yet.
            return false;
        }
        public Guid Id => new Guid("a2968bf0-0c8b-46a5-82d7-22dfddbbeaca");
        public string Name => "Passport";
        public string Description => "Local filesystem path completion";

        public SuggestionPackage GetSuggestion(PredictionClient client, PredictionContext context, CancellationToken cancellation)
        {
            string line = context.CursorPosition.Line;
            var token = context.TokenAtCursor;
            if (token == null || context.CursorPosition.ColumnNumber != line.Length + 1 ||
                token.Extent.EndColumnNumber != line.Length + 1 || token.Extent.StartLineNumber != 1)
                return default;

            // Only extend a literal command argument. Never evaluate an expression
            // or pass the user's buffer through a programmable completer.
            var command = context.RelatedAsts.OfType<CommandAst>().FirstOrDefault();
            if (command == null || command.CommandElements.Count < 2 ||
                !(command.CommandElements.Last() is StringConstantExpressionAst literal) ||
                literal.Extent.StartOffset != token.Extent.StartOffset)
                return default;
            string raw = token.Text;
            char quote = raw[0] == '\'' || raw[0] == '"' ? raw[0] : '\0';
            if (quote != '\0' && raw.Length > 1 && raw[raw.Length - 1] == quote) return default;
            string value = literal.Value;
            if (value.Length == 0 || value.StartsWith("-") || value.StartsWith(@"\\") ||
                value.StartsWith("//") || value.Contains("::")) return default;

            var location = paths.CurrentLocation;
            if (location.Provider.Name != "FileSystem") return default;
            try
            {
                string prefix = Path.GetFileName(value);
                string directory = Path.GetFullPath(value.Substring(0, value.Length - prefix.Length), location.ProviderPath);
                bool directoriesOnly = new[] { "cd", "chdir", "sl", "Set-Location", "Push-Location", "pushd" }
                    .Contains(command.GetCommandName(), StringComparer.OrdinalIgnoreCase);
                foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos())
                {
                    if (cancellation.IsCancellationRequested) return default;
                    if (directoriesOnly && !(entry is DirectoryInfo)) continue;
                    if (!entry.Name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                    string suffix = entry.Name.Substring(prefix.Length);
                    if (entry is DirectoryInfo) suffix += @"\";
                    if (suffix.Length == 0 || suffix.Any(char.IsControl)) continue;
                    if (HasHistoryMatch(line, cancellation)) return default;
                    // PowerShell also treats curly quotes as quote delimiters.
                    if (suffix.IndexOfAny(new[] { '\u2018', '\u2019', '\u201a', '\u201b', '\u201c', '\u201d', '\u201e' }) >= 0) continue;
                    if (quote == '\'') suffix = suffix.Replace("'", "''") + "'";
                    else if (quote == '"') suffix = suffix.Replace("`", "``").Replace("$", "`$").Replace("\"", "`\"") + "\"";
                    else suffix = string.Concat(suffix.Select(c => char.IsLetterOrDigit(c) || @"._-\:/".Contains(c)
                        ? c.ToString() : "`" + c));
                    return new SuggestionPackage(new List<PredictiveSuggestion> { new PredictiveSuggestion(line + suffix) });
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
            catch (NotSupportedException) { }
            return default;
        }

        public bool CanAcceptFeedback(PredictionClient client, PredictorFeedbackKind kind) =>
            commandLine == null && kind == PredictorFeedbackKind.CommandLineAccepted;
        public void OnSuggestionDisplayed(PredictionClient c, uint session, int count) { }
        public void OnSuggestionAccepted(PredictionClient c, uint session, string text) { }
        public void OnCommandLineAccepted(PredictionClient c, IReadOnlyList<string> history) => sessionHistory = history;
        public void OnCommandLineExecuted(PredictionClient c, string text, bool success) { }
    }
}
