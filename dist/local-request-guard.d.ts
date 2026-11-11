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
export declare const LocalEdgeKit_defaultBindHost = "127.0.0.1";
/** Inputs for one Host/Origin decision. */
export type LocalEdgeKit_LocalRequestGuardInput = {
    /**
     * Extra `host` or `host:port` values the caller accepts, written exactly as a browser sends
     * them in the Host header. Needed when the server is reached through a reverse proxy name.
     */
    readonly allowedHosts?: readonly string[] | undefined;
    /** The bind host the server was started with, after the loopback default was applied. */
    readonly bindHost: string;
    readonly hostHeader: string | undefined;
    /** The port the request arrived on. */
    readonly localPort: number | undefined;
    readonly originHeader: string | undefined;
};
/** Outcome of a Host/Origin decision. */
export type LocalEdgeKit_LocalRequestGuardResult = {
    readonly allowed: true;
} | {
    readonly allowed: false;
    readonly reason: "host" | "origin";
};
/** Returns the bind host to listen on: the caller's value, or loopback when none was given. */
export declare function LocalEdgeKit_resolveBindHost(bindHost: string | undefined): string;
/**
 * Decides whether a request may be served.
 *
 * The Host header must be a loopback name or the configured bind host on the port the request
 * arrived on, or one of `allowedHosts`. When an Origin header is present it must be the origin of
 * that same Host. Requests without an Origin header (top-level navigation, curl, health probes)
 * are decided by the Host check alone.
 */
export declare function LocalEdgeKit_checkLocalRequest(input: LocalEdgeKit_LocalRequestGuardInput): LocalEdgeKit_LocalRequestGuardResult;
/** Plain-text body sent with the 403 response for a rejected request. */
export declare function LocalEdgeKit_localRequestRejectionBody(reason: "host" | "origin"): string;
