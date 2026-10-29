// The oc-forge OpenChamber protocol as both ends read it, the server's reading
// of the package.json block, and the client module extensions bundle.
import { describe, expect, test } from "bun:test"
import {
  connectOcForge,
  envelope,
  matchHostShortcut,
  readOcForgeManifest,
  readOcForgeRailEntries,
  readOcForgeRequest,
  type OcForgeHello,
  type OcForgeKey,
  type OcForgeShortcuts,
} from "../adapters/openchamber/client/index"
import { parseOcForgeManifest } from "../adapters/openchamber/server/manifest.js"
import { ocForgeCommandsOnceLoaded } from "../adapters/openchamber/host/commands.ts"
import { createOcForgeServiceSocket, type OcForgeSocketLike } from "../adapters/openchamber/host/service-socket.ts"

const linux: OcForgeShortcuts = {
  mod: ["ctrl"],
  mac: false,
  bindings: {
    switch_session_tab: "mod",
    switch_context_surface: "mod+alt",
    switch_session_previous: "mod+alt+arrowleft",
    switch_session_next: "mod+alt+arrowright",
    session_history_back: "mod+[",
    session_history_forward: "mod+]",
    close_session_tab: "alt+w",
    toggle_sidebar: "mod+b",
    open_command_palette: "mod+p",
  },
}
const macBrowser: OcForgeShortcuts = { ...linux, mod: ["meta", "ctrl"], mac: true }

const press = (key: string, code: string, flags: Partial<OcForgeKey> = {}): OcForgeKey => ({
  key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...flags,
})

describe("frame requests", () => {
  test("well-formed requests are read, anything else is not", () => {
    expect(readOcForgeRequest(envelope({ type: "hello" }))).toEqual({ id: null, request: { type: "hello" } })
    expect(readOcForgeRequest({ channel: "openchamber", v: 1, type: "hello" })).toBeNull()
    expect(readOcForgeRequest({ channel: "oc-forge", v: 2, type: "hello" })).toBeNull()
    const open = readOcForgeRequest(envelope({ type: "tab-open", payload: { id: "file:///a.ts", title: " a.ts ", icon: "<svg viewBox='0 0 1 1'/>", activate: true } }, "7"))
    expect(open).toEqual({ id: "7", request: { type: "tab-open", payload: { id: "file:///a.ts", title: "a.ts", icon: "<svg viewBox='0 0 1 1'/>", activate: true } } })
    expect(readOcForgeRequest(envelope({ type: "tab-open", payload: { id: "a", title: "" } }))).toBeNull()
    expect(readOcForgeRequest(envelope({ type: "tab-open", payload: { id: "a", title: "A", icon: "javascript:alert(1)" } }))).toBeNull()
    expect(readOcForgeRequest(envelope({ type: "tab-update", payload: { id: "a", icon: null, dirty: true } }))?.request).toEqual({ type: "tab-update", payload: { id: "a", icon: null, dirty: true } })
    expect(readOcForgeRequest(envelope({ type: "route", payload: { route: "x".repeat(2049) } }))).toBeNull()
    expect(readOcForgeRequest(envelope({ type: "rail-active", payload: { entry: "a--b" } }))).toBeNull()
    expect(readOcForgeRequest(envelope({ type: "key", payload: press("1", "Digit1", { ctrlKey: true }) }))?.request.type).toBe("key")
    expect(readOcForgeRequest(envelope({ type: "key", payload: { key: "1", code: "Digit1" } }))).toBeNull()
    expect(readOcForgeRequest(envelope({ type: "tab-close-handler", payload: { on: true } }))?.request).toEqual({ type: "tab-close-handler", payload: { on: true } })
    // A tab's route: a string within the route limit; an update may clear it with null.
    expect(readOcForgeRequest(envelope({ type: "tab-open", payload: { id: "a", title: "A", route: "/tab/a" } }))?.request).toEqual({ type: "tab-open", payload: { id: "a", title: "A", route: "/tab/a" } })
    expect(readOcForgeRequest(envelope({ type: "tab-open", payload: { id: "a", title: "A", route: 7 } }))).toBeNull()
    expect(readOcForgeRequest(envelope({ type: "tab-open", payload: { id: "a", title: "A", route: "x".repeat(2049) } }))).toBeNull()
    expect(readOcForgeRequest(envelope({ type: "tab-update", payload: { id: "a", route: null } }))?.request).toEqual({ type: "tab-update", payload: { id: "a", route: null } })
    expect(readOcForgeRequest(envelope({ type: "tab-close-handler", payload: { on: "yes" } }))).toBeNull()
  })
})

describe("rail entries from a service", () => {
  test("ordered by `order`, then as listed; a bad entry is dropped on its own", () => {
    const entries = readOcForgeRailEntries({
      entries: [
        { id: "search", title: "Search", icon: "search-line" },
        { id: "scm", title: "Source Control", icon: "git-branch", order: 2 },
        { id: "explorer", title: "Explorer", icon: "<svg xmlns='http://www.w3.org/2000/svg'/>", order: 1 },
        { id: "terminal", title: "Terminal", icon: "terminal-box", zone: "bottom" },
        { id: "bad--id", title: "Reserved separator", icon: "apps" },
        { id: "scm", title: "Duplicate", icon: "apps" },
        { id: "nozone", title: "Bad zone", icon: "apps", zone: "top" },
        { id: "noicon", title: "No icon" },
        "not an object",
      ],
    })
    expect(entries?.map((entry) => entry.id)).toEqual(["explorer", "scm", "search", "terminal"])
    expect(entries?.find((entry) => entry.id === "terminal")?.zone).toBe("bottom")
    expect(readOcForgeRailEntries({ items: [] })).toBeNull()
    expect(readOcForgeRailEntries({ entries: Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, title: `E${i}`, icon: "apps" })) })).toHaveLength(32)
  })
})

describe("the ocForge manifest block", () => {
  const manifest = { contributes: { panel: { entry: "panel/index.html" }, service: { entry: "service/main.js" } } }
  test("the server reads zone and rail source, clamping the interval", () => {
    const raw = JSON.stringify({ openchamber: {}, ocForge: { apiVersion: 1, zone: "bottom", rail: { path: "/rail", interval: 10 } } })
    expect(parseOcForgeManifest(raw, manifest)).toEqual({ apiVersion: 1, zone: "bottom", rail: { path: "/rail", interval: 1000 } })
  })
  test("a rail needs a service, everything needs a panel page, other versions are ignored", () => {
    const raw = JSON.stringify({ ocForge: { apiVersion: 1, zone: "left", rail: { path: "/rail" } } })
    expect(parseOcForgeManifest(raw, { contributes: { panel: { entry: "a.html" } } })).toEqual({ apiVersion: 1, zone: "left" })
    expect(parseOcForgeManifest(raw, { contributes: { panel: {} } })).toBeNull()
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: { apiVersion: 2, zone: "left" } }), manifest)).toBeNull()
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: { apiVersion: 1, rail: { path: "../x" } } }), manifest)).toBeNull()
    expect(parseOcForgeManifest("{", manifest)).toBeNull()
  })
  test("a page may keep the bottom zone under it; that needs a page, and only `true` counts", () => {
    const raw = JSON.stringify({ ocForge: { apiVersion: 1, page: { keepBottomZone: true } } })
    const withPage = { contributes: { panel: { entry: "panel/index.html" }, page: { entry: "page/index.html" } } }
    expect(parseOcForgeManifest(raw, withPage)).toEqual({ apiVersion: 1, page: { keepBottomZone: true } })
    expect(parseOcForgeManifest(raw, manifest)).toBeNull()
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: { apiVersion: 1, page: { keepBottomZone: "yes" } } }), withPage)).toBeNull()
    expect(readOcForgeManifest({ apiVersion: 1, page: { keepBottomZone: true } })).toEqual({ apiVersion: 1, page: { keepBottomZone: true } })
    expect(readOcForgeManifest({ apiVersion: 1, page: { keepBottomZone: 1 } })).toEqual({ apiVersion: 1 })
  })
  test("the UI reads the catalog row's field the same way", () => {
    expect(readOcForgeManifest({ apiVersion: 1, rail: { path: "/rail" } })).toEqual({ apiVersion: 1, rail: { path: "/rail", interval: 3000 } })
    expect(readOcForgeManifest({ apiVersion: 1, zone: "top" })).toEqual({ apiVersion: 1 })
    expect(readOcForgeManifest("nope")).toBeUndefined()
  })
})

describe("OpenChamber's navigation shortcuts, as a frame sees them", () => {
  test("default bindings on Linux", () => {
    expect(matchHostShortcut(press("1", "Digit1", { ctrlKey: true }), linux)).toBe("switch_session_tab")
    expect(matchHostShortcut(press("0", "Digit0", { ctrlKey: true }), linux)).toBeNull()
    expect(matchHostShortcut(press("2", "Digit2", { ctrlKey: true, altKey: true }), linux)).toBe("switch_context_surface")
    expect(matchHostShortcut(press("ArrowRight", "ArrowRight", { ctrlKey: true, altKey: true }), linux)).toBe("switch_session_next")
    expect(matchHostShortcut(press("∑", "KeyW", { altKey: true }), linux)).toBe("close_session_tab")
    expect(matchHostShortcut(press("b", "KeyB", { ctrlKey: true }), linux)).toBe("toggle_sidebar")
    expect(matchHostShortcut(press("p", "KeyP", { ctrlKey: true }), linux)).toBe("open_command_palette")
    expect(matchHostShortcut(press("s", "KeyS", { ctrlKey: true }), linux)).toBeNull()
    expect(matchHostShortcut(press("b", "KeyB", { ctrlKey: true, shiftKey: true }), linux)).toBeNull()
    expect(matchHostShortcut(press("1", "Digit1", { metaKey: true }), linux)).toBeNull()
    expect(matchHostShortcut(press("1", "Digit1", { ctrlKey: true, repeat: true }), linux)).toBeNull()
  })
  test("a macOS browser takes Command or Control as mod", () => {
    expect(matchHostShortcut(press("1", "Digit1", { metaKey: true }), macBrowser)).toBe("switch_session_tab")
    expect(matchHostShortcut(press("¡", "Digit1", { metaKey: true, altKey: true }), macBrowser)).toBe("switch_context_surface")
    expect(matchHostShortcut(press("b", "KeyB", { ctrlKey: true }), macBrowser)).toBe("toggle_sidebar")
  })
  test("rebinding moves what a frame forwards", () => {
    const rebound = { ...linux, bindings: { ...linux.bindings, close_session_tab: "mod+w", switch_session_next: "ctrl+tab" } }
    expect(matchHostShortcut(press("w", "KeyW", { ctrlKey: true }), rebound)).toBe("close_session_tab")
    expect(matchHostShortcut(press("w", "KeyW", { altKey: true }), rebound)).toBeNull()
    expect(matchHostShortcut(press("Tab", "Tab", { ctrlKey: true }), rebound)).toBe("switch_session_next")
  })
})

type Posted = { data: unknown }

// A frame window whose parent records what the client posts and can answer.
const fakeFrame = () => {
  const host = { posted: [] as Posted[], postMessage(data: unknown) { this.posted.push({ data }) } }
  const frame = new EventTarget() as EventTarget & { parent: unknown }
  frame.parent = host
  const deliver = (data: unknown, source: unknown = host) => {
    const event = new Event("message")
    Object.assign(event, { data, source })
    frame.dispatchEvent(event)
  }
  return { host, frame: frame as unknown as Window, deliver }
}

const hello: OcForgeHello = {
  version: 1,
  features: ["rail", "tabs", "zones", "keys", "links"],
  extension: "ocforge-test",
  surface: "panel",
  rail: { entry: "alpha", own: false },
  tabs: { list: [], active: null, shown: false, strip: true },
  route: null,
  links: { page: "http://h/?extension=ocforge-test&route=", session: "http://h/?session=" },
  shortcuts: linux,
}

describe("the client module", () => {
  test("resolves null when the host does not answer: a stock OpenChamber", async () => {
    const { frame, host } = fakeFrame()
    expect(await connectOcForge({ target: frame, timeoutMs: 20 })).toBeNull()
    expect(host.posted[0].data).toEqual({ channel: "oc-forge", v: 1, type: "hello" })
  })

  test("outside a frame there is no host", async () => {
    const lone = new EventTarget() as EventTarget & { parent: unknown }
    lone.parent = lone
    expect(await connectOcForge({ target: lone as unknown as Window })).toBeNull()
  })

  test("hello, requests and events", async () => {
    const { frame, host, deliver } = fakeFrame()
    const connecting = connectOcForge({ target: frame, timeoutMs: 500 })
    deliver(envelope({ type: "hello", payload: { ...hello, extension: "someone-else" } }), {})
    deliver(envelope({ type: "hello", payload: hello }))
    const forge = await connecting
    expect(forge?.hello.extension).toBe("ocforge-test")
    expect(forge?.has("tabs")).toBe(true)
    expect(forge?.links.pageUrl("/task/1 a")).toBe("http://h/?extension=ocforge-test&route=%2Ftask%2F1%20a")
    expect(forge?.links.sessionUrl("ses_1")).toBe("http://h/?session=ses_1")

    const opening = forge!.tabs.open({ id: "a", title: "A" }, { activate: true })
    const request = host.posted.at(-1)!.data as { id: string; type: string; payload: unknown }
    expect(request).toMatchObject({ channel: "oc-forge", type: "tab-open", payload: { id: "a", title: "A", activate: true } })
    deliver(envelope({ type: "result", id: request.id, ok: true }))
    await opening

    const refused = forge!.tabs.activate("missing")
    deliver(envelope({ type: "result", id: (host.posted.at(-1)!.data as { id: string }).id, ok: false, error: "No such tab." }))
    await expect(refused).rejects.toThrow("No such tab.")

    const seen: string[] = []
    forge!.rail.onEntry((entry) => seen.push(`entry:${entry}`))
    forge!.tabs.onActivate((id) => seen.push(`tab:${id}`))
    forge!.tabs.onClose((id) => seen.push(`closed:${id}`))
    forge!.links.onRoute((route) => seen.push(`route:${route}`))
    deliver(envelope({ type: "rail-entry", payload: { entry: "beta" } }))
    deliver(envelope({ type: "tab-activated", payload: { id: "a" } }))
    deliver(envelope({ type: "tab-closed", payload: { id: "a" } }))
    deliver(envelope({ type: "route", payload: { route: "/x" } }))
    expect(seen).toEqual(["entry:beta", "tab:a", "closed:a", "route:/x"])
    expect(forge!.rail.entry()).toBe("beta")
    expect(forge!.links.route()).toBe("/x")
    forge!.dispose()
  })

  test("onCloseRequest: the frame decides how dirty tabs close while it listens", async () => {
    const { frame, host, deliver } = fakeFrame()
    const connecting = connectOcForge({ target: frame, timeoutMs: 500 })
    deliver(envelope({ type: "hello", payload: hello }))
    const forge = (await connecting)!
    const handlerPosts = () => host.posted.map((post) => post.data as { type: string; payload?: { on: boolean } }).filter((data) => data.type === "tab-close-handler").map((data) => data.payload?.on)
    const asked: string[] = []
    const first = forge.tabs.onCloseRequest((id) => asked.push(`one:${id}`))
    const second = forge.tabs.onCloseRequest((id) => asked.push(`two:${id}`))
    // Said once when the first listener comes, and once when the last goes.
    expect(handlerPosts()).toEqual([true])
    deliver(envelope({ type: "tab-close-request", payload: { id: "file:///a.ts" } }))
    expect(asked).toEqual(["one:file:///a.ts", "two:file:///a.ts"])
    first()
    expect(handlerPosts()).toEqual([true])
    second()
    second()
    expect(handlerPosts()).toEqual([true, false])
    deliver(envelope({ type: "tab-close-request", payload: { id: "b" } }))
    expect(asked).toHaveLength(2)
    forge.dispose()
  })

  test("forwardHostShortcuts takes OpenChamber's keys from the frame and leaves the rest", async () => {
    const { frame, host, deliver } = fakeFrame()
    const connecting = connectOcForge({ target: frame, timeoutMs: 500 })
    deliver(envelope({ type: "hello", payload: hello }))
    const forge = (await connecting)!
    const stop = forge.keys.forwardHostShortcuts({ except: ["toggle_sidebar"] })
    const key = (init: KeyboardEventInit) => {
      const event = new Event("keydown", { cancelable: true }) as KeyboardEvent
      Object.assign(event, { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...init })
      frame.dispatchEvent(event)
      return event
    }
    const before = host.posted.length
    expect(key({ key: "2", code: "Digit2", ctrlKey: true }).defaultPrevented).toBe(true)
    expect(host.posted.at(-1)!.data).toMatchObject({ type: "key", payload: { key: "2", code: "Digit2", ctrlKey: true } })
    expect(key({ key: "b", code: "KeyB", ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key({ key: "k", code: "KeyK", ctrlKey: true }).defaultPrevented).toBe(false)
    expect(host.posted.length).toBe(before + 1)
    stop()
    expect(key({ key: "2", code: "Digit2", ctrlKey: true }).defaultPrevented).toBe(false)
    forge.dispose()
  })
})

describe("a folder's commands, once OpenCode 2.2 has loaded them", () => {
  test("an empty first answer is asked again; a list is taken as it is; an empty folder gives up after the wait", async () => {
    const answers = [[], [], ["init", "review", "oc-planner-x"]]
    let asked = 0
    expect(await ocForgeCommandsOnceLoaded(async () => answers[Math.min(asked++, answers.length - 1)], 2_000, 5)).toEqual(["init", "review", "oc-planner-x"])
    expect(asked).toBe(3)
    let once = 0
    expect(await ocForgeCommandsOnceLoaded(async () => { once += 1; return ["init"] }, 2_000, 5)).toEqual(["init"])
    expect(once).toBe(1)
    const started = Date.now()
    expect(await ocForgeCommandsOnceLoaded(async () => [], 60, 10)).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })
})

describe("guest service requests over the window's socket", () => {
  type Fake = OcForgeSocketLike & { sent: string[]; closed: boolean; fire: (type: string, data?: string) => void }
  const fakeSocket = (): Fake => {
    const listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
    const socket: Fake = {
      readyState: 0,
      sent: [],
      closed: false,
      send(data) {
        if (socket.readyState !== 1) throw new Error("not open")
        socket.sent.push(data)
      },
      close() {
        socket.closed = true
        ;(socket as { readyState: number }).readyState = 3
      },
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      fire(type, data) {
        if (type === "open") (socket as { readyState: number }).readyState = 1
        if (type === "close") (socket as { readyState: number }).readyState = 3
        for (const listener of listeners.get(type) ?? []) listener({ data })
      },
    }
    return socket
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("requests share one socket and are answered by id, in any order", async () => {
    const sockets: Fake[] = []
    const transport = createOcForgeServiceSocket(() => {
      const socket = fakeSocket()
      sockets.push(socket)
      return socket
    })
    const recv = transport.request("oc-forge-vscode", { method: "POST", path: "/tunnel/recv", body: "{}" })
    const health = transport.request("oc-forge-vscode", { method: "GET", path: "/health" })
    expect(sockets).toHaveLength(1)
    sockets[0]!.fire("open")
    await tick()
    expect(sockets[0]!.sent).toEqual([
      '1 oc-forge-vscode\n{"method":"POST","path":"/tunnel/recv","body":"{}"}',
      '2 oc-forge-vscode\n{"method":"GET","path":"/health"}',
    ])
    sockets[0]!.fire("message", '2 200\n{"status":200,"body":"ok"}')
    expect(await health).toEqual({ status: 200, text: '{"status":200,"body":"ok"}' })
    sockets[0]!.fire("message", '1 400\n{"error":"invalid-request"}')
    expect(await recv).toEqual({ status: 400, text: '{"error":"invalid-request"}' })
    // An answer nobody waits for is dropped.
    sockets[0]!.fire("message", "9 200\nnull")
  })

  test("what was not sent is left to fetch: no socket, an id the server would refuse", async () => {
    let opened = 0
    const none = createOcForgeServiceSocket(() => {
      opened += 1
      return null
    })
    expect(await none.request("oc-forge-vscode", {})).toBeNull()
    expect(await none.request("Not An Id", {})).toBeNull()
    expect(opened).toBe(1)
  })

  test("a socket that will not open sends everything over fetch for a while, then is tried again", async () => {
    let clock = 0
    const sockets: Fake[] = []
    const transport = createOcForgeServiceSocket(() => {
      const socket = fakeSocket()
      sockets.push(socket)
      return socket
    }, () => clock)
    const first = transport.request("ocforge-test", {})
    sockets[0]!.fire("error")
    sockets[0]!.fire("close")
    expect(await first).toBeNull()
    expect(sockets[0]!.closed).toBe(true)
    clock = 29_000
    expect(await transport.request("ocforge-test", {})).toBeNull()
    expect(sockets).toHaveLength(1)
    clock = 31_000
    const later = transport.request("ocforge-test", {})
    expect(sockets).toHaveLength(2)
    sockets[1]!.fire("open")
    await tick()
    sockets[1]!.fire("message", "1 200\n{}")
    expect(await later).toEqual({ status: 200, text: "{}" })
  })

  test("a socket that goes fails its requests in flight without sending them again, and the next request opens another", async () => {
    const sockets: Fake[] = []
    const transport = createOcForgeServiceSocket(() => {
      const socket = fakeSocket()
      sockets.push(socket)
      return socket
    })
    const inFlight = transport.request("oc-forge-vscode", { method: "POST", path: "/tunnel/send" })
    sockets[0]!.fire("open")
    await tick()
    sockets[0]!.fire("close")
    expect(await inFlight).toEqual({ status: 502, text: "null" })
    expect(sockets[0]!.sent).toHaveLength(1)
    const next = transport.request("oc-forge-vscode", { method: "GET", path: "/health" })
    expect(sockets).toHaveLength(2)
    sockets[1]!.fire("open")
    await tick()
    expect(sockets[1]!.sent).toEqual(['2 oc-forge-vscode\n{"method":"GET","path":"/health"}'])
    sockets[1]!.fire("message", '2 200\n{"status":200,"body":"ok"}')
    expect((await next)?.status).toBe(200)
  })
})
