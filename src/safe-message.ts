/**
 * @fileoverview Bounded text for error and warning messages. Environment variable values are never put in a
 * message: those messages name the variable and the rule only. Command-line words and env variable
 * names go through the helpers here, which repeat them only when they are short and plainly shaped.
 */

/** Shape of a command-line word the kit repeats in a message, such as a `--method` value. */
const LOCAL_EDGE_KIT_MESSAGE_WORD_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

/** Shape of an environment variable name the kit repeats in a message. */
const LOCAL_EDGE_KIT_MESSAGE_ENV_NAME_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Most env variable names `LocalEdgeKit_messageEnvNames` repeats. */
const LOCAL_EDGE_KIT_MESSAGE_NAMES_MAX_COUNT = 5;

/** `<N characters>`, or `<1 character>` for a single one, the same wording core 0.4.1 uses. */
function LocalEdgeKit_lengthPlaceholder(length: number): string {
  return length === 1 ? "<1 character>" : `<${String(length)} characters>`;
}

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
export function LocalEdgeKit_messageWord(value: string): string {
  return LOCAL_EDGE_KIT_MESSAGE_WORD_SHAPE.test(value) ? value : LocalEdgeKit_lengthPlaceholder(value.length);
}

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
export function LocalEdgeKit_messageFlag(value: string): string {
  const dashes = /^-{1,2}/.exec(value)?.[0] ?? "";
  return `${dashes}${LocalEdgeKit_messageWord(value.slice(dashes.length))}`;
}

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
export function LocalEdgeKit_messageEnvNames(names: readonly string[]): string {
  const shown = names
    .slice(0, LOCAL_EDGE_KIT_MESSAGE_NAMES_MAX_COUNT)
    .map((name) => (LOCAL_EDGE_KIT_MESSAGE_ENV_NAME_SHAPE.test(name) ? name : LocalEdgeKit_lengthPlaceholder(name.length)));
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(",")} (and ${String(rest)} more)` : shown.join(",");
}

/** Longest command line `LocalEdgeKit_boundedCommandLine` returns, in characters. */
export const LOCAL_EDGE_KIT_COMMAND_LINE_MAX_CHARS = 200;

/**
 * Bounds an observed process command line for display: control characters (including newlines,
 * tabs and escape bytes), bidirectional and other invisible format characters (Unicode category
 * Cf: for example U+202A-U+202E, U+2066-U+2069, U+200B-U+200F, U+FEFF) and the line and paragraph
 * separators U+2028 and U+2029 are removed, and the text is cut to 200 characters, the last of
 * them `…` when something was cut. Unlike `LocalEdgeKit_messageWord` it keeps the words, because a
 * status row exists to show the command; it is meant for status output, not for error messages.
 * It only edits the command line text it is given; it reads no process environment.
 *
 * @param value - The command line as the process list printed it.
 * @returns Text of at most 200 characters without control or format characters.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_boundedCommandLine("node\u001b[0m server.js\n"); // "node[0m server.js"
 * ```
 */
export function LocalEdgeKit_boundedCommandLine(value: string): string {
  const plain = [...value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")];
  return plain.length > LOCAL_EDGE_KIT_COMMAND_LINE_MAX_CHARS
    ? `${plain.slice(0, LOCAL_EDGE_KIT_COMMAND_LINE_MAX_CHARS - 1).join("")}…`
    : plain.join("");
}
