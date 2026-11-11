/**
 * @fileoverview Bind-address default and Host/Origin request checks shared by the kit's local HTTP servers.
 *
 * A local development server is reachable by any page open in the developer's browser. Two checks
 * keep such pages out: the Host header must name this server (which defeats DNS rebinding, where a
 * foreign name is re-pointed at 127.0.0.1), and an Origin header, when present, must be the
 * server's own origin (which defeats cross-site requests and cross-site websocket connections).
 * The module also owns the loopback bind default so no server listens on every interface unless
 * its caller asked for that.
 *
 * @testing Node test runner unit: npm test -- src/local-request-guard.unit.test.ts
 *
 * @see src/helper-dashboard-server.ts - Applies the guard to every helper-dashboard request.
 * @see src/logs-web-server.ts - Applies the guard to every logs-web request and websocket upgrade.
 */
/** Address the kit's servers bind when the caller gives no bind host. */
export const LocalEdgeKit_defaultBindHost = "127.0.0.1";
/** Host names that always mean this machine. */
const LocalEdgeKit_loopbackHostnames = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]",
]);
/** Bind addresses that mean "every interface" and so can never be a request Host. */
const LocalEdgeKit_wildcardBindHosts = new Set([
    "0.0.0.0",
    "[::]",
]);
/** Returns the bind host to listen on: the caller's value, or loopback when none was given. */
export function LocalEdgeKit_resolveBindHost(bindHost) {
    // An empty host would make Node listen on every interface, so it counts as "not given".
    const trimmed = bindHost?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : LocalEdgeKit_defaultBindHost;
}
/** Lower-cases a host name and puts a bare IPv6 address into its bracketed header form. */
function LocalEdgeKit_normalizeHostname(hostname) {
    const lower = hostname.trim().toLowerCase();
    return lower.includes(":") && !lower.startsWith("[") ? `[${lower}]` : lower;
}
/** Parses a `host` or `host:port` header value. Returns null when it is not exactly that. */
function LocalEdgeKit_parseHost(value) {
    const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/.exec(value.trim().toLowerCase());
    if (match === null) {
        return null;
    }
    const hostname = match[1];
    if (hostname === undefined) {
        return null;
    }
    const portText = match[2];
    return {
        hostname,
        port: portText === undefined ? null : Number(portText),
    };
}
function LocalEdgeKit_isAllowedHost(options) {
    const { host } = options;
    const bindHostname = LocalEdgeKit_normalizeHostname(options.bindHost);
    const namesThisServer = LocalEdgeKit_loopbackHostnames.has(host.hostname) ||
        (!LocalEdgeKit_wildcardBindHosts.has(bindHostname) &&
            host.hostname === bindHostname);
    // A Host without a port means port 80, the only port a browser leaves out for plain HTTP.
    if (namesThisServer && (host.port ?? 80) === options.localPort) {
        return true;
    }
    return options.allowedHosts.some((entry) => {
        const allowed = LocalEdgeKit_parseHost(entry);
        return (allowed !== null &&
            allowed.hostname === host.hostname &&
            allowed.port === host.port);
    });
}
function LocalEdgeKit_isOwnOrigin(options) {
    let origin;
    try {
        origin = new URL(options.originHeader);
    }
    catch {
        // Includes the literal "null" origin sent by sandboxed and file-based pages.
        return false;
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
        return false;
    }
    if (origin.hostname.toLowerCase() !== options.host.hostname) {
        return false;
    }
    // The scheme is not compared: behind a TLS-terminating proxy the page is https while this
    // server speaks http. A Host without a port matches an origin on its scheme's default port.
    if (options.host.port === null) {
        return origin.port === "";
    }
    const originPort = origin.port === ""
        ? origin.protocol === "https:"
            ? 443
            : 80
        : Number(origin.port);
    return originPort === options.host.port;
}
/**
 * Decides whether a request may be served.
 *
 * The Host header must be a loopback name or the configured bind host on the port the request
 * arrived on, or one of `allowedHosts`. When an Origin header is present it must be the origin of
 * that same Host. Requests without an Origin header (top-level navigation, curl, health probes)
 * are decided by the Host check alone.
 */
export function LocalEdgeKit_checkLocalRequest(input) {
    const host = input.hostHeader === undefined
        ? null
        : LocalEdgeKit_parseHost(input.hostHeader);
    if (host === null ||
        !LocalEdgeKit_isAllowedHost({
            allowedHosts: input.allowedHosts ?? [],
            bindHost: input.bindHost,
            host,
            localPort: input.localPort,
        })) {
        return { allowed: false, reason: "host" };
    }
    if (input.originHeader !== undefined &&
        !LocalEdgeKit_isOwnOrigin({ host, originHeader: input.originHeader })) {
        return { allowed: false, reason: "origin" };
    }
    return { allowed: true };
}
/** Plain-text body sent with the 403 response for a rejected request. */
export function LocalEdgeKit_localRequestRejectionBody(reason) {
    return reason === "host"
        ? "Forbidden: Host header is not allowed"
        : "Forbidden: cross-origin request";
}
