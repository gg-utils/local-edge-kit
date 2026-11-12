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
 * Names a list of environment variable names in a message, comma separated: at most five, each
 * repeated only when it has the env variable name shape (otherwise `<N characters>`), then a count
 * of the rest. Names only; this never receives a value.
 *
 * @param names - The variable names as given.
 * @returns Text that is safe to put in a message.
 *
 * @example
 * ```typescript
 * LocalEdgeKit_messageEnvNames(["A_KEY", "B_KEY"]); // "A_KEY, B_KEY"
 * LocalEdgeKit_messageEnvNames(["bad name"]); // "<8 characters>"
 * ```
 */
export declare function LocalEdgeKit_messageEnvNames(names: readonly string[]): string;
