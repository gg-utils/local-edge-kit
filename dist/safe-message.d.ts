/**
 * @fileoverview Bounded text for error and warning messages. Environment variable values are never put in a
 * message: those messages name the variable and the rule only. Command-line words and env variable
 * names go through the helpers here, which repeat them only when they are short and plainly shaped.
 */
/**
 * Names a command-line word, such as a `--method` value, in a message: the word itself when it is
 * short and plain, otherwise `<N characters>`.
 *
 * A short alphanumeric token (up to 48 characters) is still repeated, by design: command-line
 * input is not secret, and naming the rejected word helps the person who typed it. Control
 * characters, spaces and anything longer are never repeated. Environment variable values must not
 * go through this helper.
 *
 * @param value - The word as given.
 * @returns Text that is safe to put in a message.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_messageWord("render"); // "render"
 * LocalEdgeKit_messageWord("a b"); // "<3 characters>"
 * ```
 */
export declare function LocalEdgeKit_messageWord(value: string): string;
/**
 * Names a command-line option such as `--help` in a message: up to two leading dashes are kept
 * and the rest goes through `LocalEdgeKit_messageWord`, so `--hlep` is still named while
 * `--x=<anything with spaces>` is not.
 *
 * @param value - The option as given.
 * @returns Text that is safe to put in a message.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_messageFlag("--hlep"); // "--hlep"
 * LocalEdgeKit_messageFlag("--a b"); // "--<3 characters>"
 * ```
 */
export declare function LocalEdgeKit_messageFlag(value: string): string;
/**
 * Names a list of environment variable names in a message, comma separated: at most five, each
 * repeated only when it has the env variable name shape (otherwise `<N characters>`), then a count
 * of the rest. Names only; this never receives a value.
 *
 * @param names - The variable names as given.
 * @returns Text that is safe to put in a message.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_messageEnvNames(["A_KEY", "B_KEY"]); // "A_KEY,B_KEY"
 * LocalEdgeKit_messageEnvNames(["bad name"]); // "<8 characters>"
 * ```
 */
export declare function LocalEdgeKit_messageEnvNames(names: readonly string[]): string;
/** Longest command line `LocalEdgeKit_boundedCommandLine` returns, in characters. */
export declare const LOCAL_EDGE_KIT_COMMAND_LINE_MAX_CHARS = 200;
/**
 * Bounds an observed process command line for display: control characters (including newlines,
 * tabs and escape bytes) are removed and the text is cut to 200 characters, the last of them `…`
 * when something was cut. Unlike `LocalEdgeKit_messageWord` it keeps the words, because a status
 * row exists to show the command; it is meant for status output, not for error messages. The
 * environment is never read, only the command line the process list prints.
 *
 * @param value - The command line as the process list printed it.
 * @returns Text of at most 200 characters without control characters.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_boundedCommandLine("node\u001b[0m server.js\n"); // "node[0m server.js"
 * ```
 */
export declare function LocalEdgeKit_boundedCommandLine(value: string): string;
