// The oc-forge OpenChamber protocol as both ends read it, the server's reading
// of the package.json block, and the client module extensions bundle.
import { describe, expect, test } from "bun:test"
import {
  connectOcForge,
  envelope,
  matchHostShortcut,
  parseOcForgeRequest,
  readOcForgeManifest,
  readOcForgeRequest,
  type OcForgeHello,
  type OcForgeKey,
  type OcForgeShortcuts,
} from "../adapters/openchamber/client/index"
import { ocForgeDocumentSandbox, parseOcForgeManifest } from "../adapters/openchamber/server/manifest.js"
import { ocForgeCommandsOnceLoaded } from "../adapters/openchamber/host/commands.ts"

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
    expect(readOcForgeRequest(envelope({ type: "route", payload: { route: "/task/1", push: true } }, "7"))).toEqual({ id: "7", request: { type: "route", payload: { route: "/task/1", push: true } } })
    expect(readOcForgeRequest(envelope({ type: "route", payload: { route: "x".repeat(2048) } }))?.request.type).toBe("route")
    expect(readOcForgeRequest(envelope({ type: "route", payload: { route: "x".repeat(2049) } }))).toBeNull()
    expect(readOcForgeRequest(envelope({ type: "key", payload: press("1", "Digit1", { ctrlKey: true }) }))?.request.type).toBe("key")
    expect(readOcForgeRequest(envelope({ type: "key", payload: { key: "1", code: "Digit1" } }))).toBeNull()
  })

  test("one the host can't take says why, for the host to answer at once; anything not on the channel is nothing", () => {
    expect(parseOcForgeRequest({ channel: "openchamber", v: 1, type: "hello" })).toBeNull()
    expect(parseOcForgeRequest({ channel: "oc-forge", v: 1 })).toBeNull()
    const refused = (type: string, payload: unknown) => parseOcForgeRequest(envelope({ type, payload }, "9")) as { id: string; error: string }
    expect(refused("route", { route: "x".repeat(2049) })).toEqual({ id: "9", error: "Refused route: a route is at most 2048 characters." })
    expect(refused("route", { route: "/x", push: 1 }).error).toBe("Refused route: push is true or false.")
    expect(refused("key", { key: "1" }).error).toMatch(/^Refused key: a press has/)
    // What only the VS Code extension used (header tabs, rail entries, the window's id) is no request any more.
    for (const type of ["tab-open", "rail-open", "rail-badges", "page-warm"]) {
      expect(refused(type, { id: "a", title: "A", entry: "terminal" }).error).toBe(`Refused ${type}: not a request this host knows.`)
    }
    // Without an id there is nothing to answer, but it is still refused.
    expect(parseOcForgeRequest(envelope({ type: "route", payload: {} }))).toEqual({ id: null, error: "Refused route: a route is at most 2048 characters." })
  })
})

describe("the ocForge manifest block", () => {
  const manifest = { contributes: { panel: { entry: "panel/index.html" }, service: { entry: "service/main.js" } } }
  test("frames may ask for allow-modals (print); that needs only a panel page, and only `true` counts", () => {
    const panelOnly = { contributes: { panel: { entry: "panel/index.html" } } }
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: { apiVersion: 1, modals: true } }), panelOnly)).toEqual({ apiVersion: 1, modals: true })
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: { apiVersion: 1, modals: "yes" } }), manifest)).toBeNull()
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: { apiVersion: 1, modals: true } }), { contributes: { panel: {} } })).toBeNull()
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: { apiVersion: 2, modals: true } }), manifest)).toBeNull()
    expect(parseOcForgeManifest("{", manifest)).toBeNull()
    expect(readOcForgeManifest({ apiVersion: 1, modals: true })).toEqual({ apiVersion: 1, modals: true })
    expect(readOcForgeManifest({ apiVersion: 1, modals: "true" })).toEqual({ apiVersion: 1 })
    expect(readOcForgeManifest("nope")).toBeUndefined()
    // The server's CSP sandboxes the document as well: it widens only for the extension that asks.
    expect(ocForgeDocumentSandbox({ ocForge: { apiVersion: 1, modals: true } })).toBe("sandbox allow-scripts allow-modals")
    expect(ocForgeDocumentSandbox({ ocForge: { apiVersion: 1 } })).toBe("sandbox allow-scripts")
    expect(ocForgeDocumentSandbox({})).toBe("sandbox allow-scripts")
  })
  test("what only the VS Code extension used (a default zone, rail entries, the bottom zone under a page) is ignored", () => {
    const withPage = { contributes: { ...manifest.contributes, page: { entry: "page/index.html" } } }
    const old = { apiVersion: 1, zone: "bottom", rail: { path: "/rail", interval: 1000 }, page: { keepBottomZone: true } }
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: old }), withPage)).toBeNull()
    expect(parseOcForgeManifest(JSON.stringify({ ocForge: { ...old, modals: true } }), withPage)).toEqual({ apiVersion: 1, modals: true })
    expect(readOcForgeManifest(old)).toEqual({ apiVersion: 1 })
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
  test("in an app window Chrome's tab keys are aliases, beside the bindings; elsewhere they are not", () => {
    const appWindow: OcForgeShortcuts = { ...linux, aliases: { switch_session_next: ["ctrl+tab"], switch_session_previous: ["ctrl+shift+tab"], close_session_tab: ["mod+w"] } }
    expect(matchHostShortcut(press("Tab", "Tab", { ctrlKey: true }), appWindow)).toBe("switch_session_next")
    expect(matchHostShortcut(press("Tab", "Tab", { ctrlKey: true, shiftKey: true }), appWindow)).toBe("switch_session_previous")
    expect(matchHostShortcut(press("w", "KeyW", { ctrlKey: true }), appWindow)).toBe("close_session_tab")
    // The bindings still work, and the aliases are only where the host sent them.
    expect(matchHostShortcut(press("ArrowRight", "ArrowRight", { ctrlKey: true, altKey: true }), appWindow)).toBe("switch_session_next")
    expect(matchHostShortcut(press("Tab", "Tab", { ctrlKey: true }), linux)).toBeNull()
    expect(matchHostShortcut(press("w", "KeyW", { ctrlKey: true }), linux)).toBeNull()
    const macApp: OcForgeShortcuts = { ...macBrowser, aliases: { close_session_tab: ["mod+w"], switch_session_next: ["ctrl+tab"] } }
    expect(matchHostShortcut(press("w", "KeyW", { metaKey: true }), macApp)).toBe("close_session_tab")
    expect(matchHostShortcut(press("Tab", "Tab", { ctrlKey: true }), macApp)).toBe("switch_session_next")
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
  features: ["keys", "links"],
  extension: "ocforge-test",
  surface: "page",
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
    expect(forge?.has("links")).toBe(true)
    expect(forge?.has("modals")).toBe(false)
    expect(forge?.links.pageUrl("/task/1 a")).toBe("http://h/?extension=ocforge-test&route=%2Ftask%2F1%20a")
    expect(forge?.links.sessionUrl("ses_1")).toBe("http://h/?session=ses_1")

    const routing = forge!.links.setRoute("/task/1", { push: true })
    const request = host.posted.at(-1)!.data as { id: string; type: string; payload: unknown }
    expect(request).toMatchObject({ channel: "oc-forge", type: "route", payload: { route: "/task/1", push: true } })
    deliver(envelope({ type: "result", id: request.id, ok: true }))
    await routing
    expect(forge!.links.route()).toBe("/task/1")

    const refused = forge!.keys.forward(press("i", "KeyI", { ctrlKey: true }))
    deliver(envelope({ type: "result", id: (host.posted.at(-1)!.data as { id: string }).id, ok: false, error: "Not one of the OpenChamber navigation shortcuts a frame may forward." }))
    await expect(refused).rejects.toThrow("Not one of the OpenChamber navigation shortcuts")

    const seen: string[] = []
    forge!.links.onRoute((route) => seen.push(`route:${route}`))
    forge!.keys.onChange((shortcuts) => seen.push(`close:${shortcuts.bindings.close_session_tab}`))
    deliver(envelope({ type: "route", payload: { route: "/x" } }))
    deliver(envelope({ type: "shortcuts", payload: { ...linux, bindings: { ...linux.bindings, close_session_tab: "mod+w" } } }))
    // Events of what the host no longer has are nothing to the client.
    deliver(envelope({ type: "tab-activated", payload: { id: "a" } }))
    expect(seen).toEqual(["route:/x", "close:mod+w"])
    expect(forge!.links.route()).toBe("/x")
    expect(forge!.keys.shortcuts().bindings.close_session_tab).toBe("mod+w")
    forge!.dispose()
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
