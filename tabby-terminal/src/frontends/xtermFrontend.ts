import deepEqual from 'deep-equal'
import { BehaviorSubject, filter, firstValueFrom, takeUntil } from 'rxjs'
import { Injector } from '@angular/core'
import { ConfigService, getCSSFontFamily, getWindows10Build, HostAppService, HotkeysService, Platform, PlatformService, ThemesService } from 'tabby-core'
import { Frontend, SearchOptions, SearchState, TerminalLineTimestampOptions, TerminalWriteMetadata } from './frontend'
import { Terminal, ITheme, IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import { ISearchOptions, SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import { ImageAddon } from '@xterm/addon-image'
import { CanvasAddon } from '@xterm/addon-canvas'
import { BaseTerminalProfile, TerminalColorScheme } from '../api/interfaces'
import { getTerminalBackgroundColor } from '../helpers'
import './xterm.css'

const COLOR_NAMES = [
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

type XTermBufferType = 'normal' | 'alternate'

interface TrackedRange {
    start: number
    end: number
}

interface LineTimestampEntry {
    bufferType: XTermBufferType
    marker: IMarker
    timestamp: number
}

interface LineSnapshot {
    bufferType: XTermBufferType
    range: TrackedRange
    lines: Map<number, string>
}

class FlowControl {
    private blocked = false
    private blocked$ = new BehaviorSubject<boolean>(false)
    private pendingCallbacks = 0
    private lowWatermark = 5
    private highWatermark = 10
    private bytesWritten = 0
    private bytesThreshold = 1024 * 128

    constructor (private xterm: Terminal) { }

    async write (data: string, waitForParse = false) {
        if (this.blocked) {
            await firstValueFrom(this.blocked$.pipe(filter(x => !x)))
        }

        this.bytesWritten += data.length
        const shouldTrackBackpressure = this.bytesWritten > this.bytesThreshold
        const shouldWait = waitForParse || shouldTrackBackpressure

        if (shouldTrackBackpressure) {
            this.pendingCallbacks++
            this.bytesWritten = 0
            if (!this.blocked && this.pendingCallbacks > this.highWatermark) {
                this.blocked = true
                this.blocked$.next(true)
            }
        }

        if (!shouldWait) {
            this.xterm.write(data)
            return
        }

        await new Promise<void>(resolve => {
            this.xterm.write(data, () => {
                if (shouldTrackBackpressure) {
                    this.pendingCallbacks--
                    if (this.blocked && this.pendingCallbacks < this.lowWatermark) {
                        this.blocked = false
                        this.blocked$.next(false)
                    }
                }
                resolve()
            })
        })
    }
}

class XTermLineTimestampGutter {
    private static readonly SAMPLE_TEXT = '[00:00:00]'
    private static readonly RANGE_MARGIN = 8
    private static readonly CONTENT_GAP_COLUMNS = 1
    private static readonly TEXT_BASELINE: CanvasTextBaseline = navigator.userAgent.includes('Firefox') ? 'bottom' : 'ideographic'

    private host?: HTMLElement
    private container?: HTMLDivElement
    private canvas?: HTMLCanvasElement
    private canvasContext?: CanvasRenderingContext2D
    private options: TerminalLineTimestampOptions = {
        enabled: false,
        hideInAlternateScreen: true,
    }

    private entries: LineTimestampEntry[] = []
    private pendingTimestamp?: number
    private pendingSnapshot?: LineSnapshot
    private gutterWidthPx = 0
    private contentGapPx = 0
    private layoutInvalidated = true
    private typographyKey?: string
    private readonly measureContext = document.createElement('canvas').getContext('2d')

    private readonly fontLoadingListener = () => {
        if (!this.host) {
            return
        }
        this.invalidateLayout()
        this.refreshLayout()
        this.renderVisibleRows()
    }

    constructor (
        private xterm: Terminal,
        private getRowHeight: () => number,
        private getRenderDimensions: () => any,
    ) { }

    attach (host: HTMLElement): void {
        if (this.container) {
            return
        }

        this.host = host
        host.classList.add('tabby-line-timestamp-host')

        this.container = document.createElement('div')
        this.container.classList.add('tabby-line-timestamp-gutter')

        this.canvas = document.createElement('canvas')
        this.canvas.classList.add('tabby-line-timestamp-gutter-canvas')
        this.canvasContext = this.canvas.getContext('2d') ?? undefined

        this.container.appendChild(this.canvas)
        host.appendChild(this.container)

        this.installFontListeners()
        this.invalidateLayout()
        this.refreshLayout()
        this.renderVisibleRows()
    }

    detach (): void {
        if (!this.host) {
            return
        }

        this.container?.remove()
        this.removeFontListeners()
        this.host.classList.remove('tabby-line-timestamp-host')
        this.host.classList.remove('tabby-line-timestamp-active')
        this.host.style.removeProperty('--tabby-line-timestamp-gutter-width')
        this.host.style.removeProperty('--tabby-line-timestamp-gap-width')
        this.host = undefined
        this.container = undefined
        this.canvas = undefined
        this.canvasContext = undefined
        this.gutterWidthPx = 0
        this.contentGapPx = 0
        this.layoutInvalidated = true
        this.typographyKey = undefined
    }

    dispose (): void {
        for (const entry of this.entries) {
            if (!entry.marker.isDisposed) {
                entry.marker.dispose()
            }
        }
        this.entries = []
        this.pendingSnapshot = undefined
        this.pendingTimestamp = undefined
        this.detach()
    }

    setOptions (options: TerminalLineTimestampOptions): void {
        this.options = options
        this.refreshLayout()
        this.renderVisibleRows()
    }

    isEnabled (): boolean {
        return this.options.enabled
    }

    invalidateLayout (): void {
        this.layoutInvalidated = true
    }

    beforeWrite (timestamp?: number): void {
        this.pendingTimestamp = timestamp
        this.pendingSnapshot = timestamp ? this.snapshotActiveRange() : undefined
    }

    afterWrite (): void {
        const timestamp = this.pendingTimestamp
        const before = this.pendingSnapshot
        this.pendingTimestamp = undefined
        this.pendingSnapshot = undefined

        if (!timestamp || !before) {
            return
        }

        const activeBuffer = this.xterm.buffer.active
        const afterRange = this.buildTrackedRange(activeBuffer)
        const range = before.bufferType === activeBuffer.type
            ? {
                start: Math.min(before.range.start, afterRange.start),
                end: Math.max(before.range.end, afterRange.end),
            }
            : afterRange
        const after = this.snapshotRange(activeBuffer.type, range)
        const changedLines = new Set<number>()

        if (before.bufferType === after.bufferType) {
            for (let line = range.start; line <= range.end; line++) {
                if (before.lines.get(line) !== after.lines.get(line)) {
                    changedLines.add(line)
                }
            }
        } else {
            for (const line of after.lines.keys()) {
                changedLines.add(line)
            }
        }

        for (const line of changedLines) {
            this.updateEntry(after.bufferType, line, timestamp)
        }

        this.cleanupDisposedEntries()
    }

    renderVisibleRows (): void {
        if (!this.canvas || !this.canvasContext) {
            return
        }

        if (!this.options.enabled) {
            this.clearCanvas()
            return
        }

        this.refreshLayout()
        this.cleanupDisposedEntries()

        if (!this.isEffectivelyVisible()) {
            this.clearCanvas()
            return
        }

        this.syncTypography()
        const geometry = this.syncCanvasGeometry()
        const ctx = this.canvasContext
        const buffer = this.xterm.buffer.active
        const viewportY = buffer.viewportY
        const color = getComputedStyle(this.container ?? this.canvas).color

        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, geometry.deviceWidth, geometry.deviceHeight)
        ctx.font = this.getCanvasFont(geometry.dpr)
        ctx.textBaseline = XTermLineTimestampGutter.TEXT_BASELINE
        ctx.fillStyle = color

        for (let row = 0; row < this.xterm.rows; row++) {
            const absoluteLine = viewportY + row
            const bufferLine = buffer.getLine(absoluteLine)
            if (!bufferLine || bufferLine.isWrapped) {
                continue
            }

            const entry = this.findEntryForLine(buffer.type, absoluteLine)
            if (entry) {
                const label = this.formatTimestamp(entry.timestamp)
                const metrics = ctx.measureText(label)
                const x = geometry.deviceWidth - Math.max(metrics.actualBoundingBoxRight, metrics.width)
                const y = row * geometry.deviceCellHeight + geometry.deviceCharTop + geometry.deviceCharHeight
                ctx.fillText(label, x, y)
            }
        }

        ctx.restore()
    }

    private snapshotActiveRange (): LineSnapshot {
        const buffer = this.xterm.buffer.active
        return this.snapshotRange(buffer.type, this.buildTrackedRange(buffer))
    }

    private snapshotRange (bufferType: XTermBufferType, range: TrackedRange): LineSnapshot {
        const buffer = this.xterm.buffer.active.type === bufferType ? this.xterm.buffer.active : this.getBufferByType(bufferType)
        const lines = new Map<number, string>()

        for (let line = range.start; line <= range.end; line++) {
            const bufferLine = buffer.getLine(line)
            if (!bufferLine) {
                continue
            }
            lines.set(line, `${bufferLine.isWrapped ? '1' : '0'}:${bufferLine.translateToString(false)}`)
        }

        return {
            bufferType,
            range,
            lines,
        }
    }

    private buildTrackedRange (buffer = this.xterm.buffer.active): TrackedRange {
        if (buffer.length <= 0) {
            return { start: 0, end: 0 }
        }

        const cursorLine = buffer.baseY + buffer.cursorY
        const viewportStart = buffer.viewportY
        const viewportEnd = buffer.viewportY + this.xterm.rows - 1
        const start = Math.max(0, Math.min(cursorLine, viewportStart) - XTermLineTimestampGutter.RANGE_MARGIN)
        const end = Math.max(
            start,
            Math.min(
                buffer.length - 1,
                Math.max(cursorLine + 4, viewportEnd) + XTermLineTimestampGutter.RANGE_MARGIN,
            ),
        )

        return { start, end }
    }

    private updateEntry (bufferType: XTermBufferType, line: number, timestamp: number): void {
        const buffer = this.xterm.buffer.active
        if (buffer.type !== bufferType || !buffer.getLine(line)) {
            return
        }

        this.entries = this.entries.filter(entry => {
            if (entry.bufferType !== bufferType || entry.marker.line !== line) {
                return true
            }
            if (!entry.marker.isDisposed) {
                entry.marker.dispose()
            }
            return false
        })

        const marker = this.registerMarkerForLine(line)
        if (!marker) {
            return
        }

        marker.onDispose(() => {
            this.entries = this.entries.filter(entry => entry.marker !== marker)
        })

        this.entries.push({
            bufferType,
            marker,
            timestamp,
        })
    }

    private registerMarkerForLine (line: number): IMarker | undefined {
        const buffer = this.xterm.buffer.active
        if (!buffer.getLine(line)) {
            return undefined
        }

        const cursorLine = buffer.baseY + buffer.cursorY
        return this.xterm.registerMarker(line - cursorLine)
    }

    private findEntryForLine (bufferType: XTermBufferType, line: number): LineTimestampEntry | undefined {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const entry = this.entries[i]
            if (entry.bufferType === bufferType && entry.marker.line === line && !entry.marker.isDisposed) {
                return entry
            }
        }
        return undefined
    }

    private cleanupDisposedEntries (): void {
        this.entries = this.entries.filter(entry => !entry.marker.isDisposed && entry.marker.line >= 0)
    }

    private refreshLayout (): void {
        if (!this.host || !this.container) {
            return
        }

        const visible = this.isEffectivelyVisible()
        const gutterWidth = visible ? this.measureGutterWidth() : 0
        const contentGap = visible ? this.measureContentGap() : 0
        this.host.style.setProperty('--tabby-line-timestamp-gutter-width', `${gutterWidth}px`)
        this.host.style.setProperty('--tabby-line-timestamp-gap-width', `${contentGap}px`)
        this.host.classList.toggle('tabby-line-timestamp-active', visible)
        this.container.style.display = visible ? 'block' : 'none'
        this.container.style.width = `${gutterWidth}px`
    }

    private measureGutterWidth (): number {
        this.syncTypography()
        return this.gutterWidthPx
    }

    private measureContentGap (): number {
        this.syncTypography()
        return this.contentGapPx
    }

    private syncTypography (): void {
        if (!this.container || !this.measureContext) {
            return
        }

        const typography = this.getTypography()
        const typographyKey = JSON.stringify(typography)
        if (!this.layoutInvalidated && this.typographyKey === typographyKey) {
            return
        }

        this.container.style.fontFamily = typography.fontFamily
        this.container.style.fontSize = `${typography.fontSize}px`
        this.container.style.fontWeight = typography.fontWeight
        this.container.style.letterSpacing = `${typography.letterSpacing}px`

        this.measureContext.font = `${typography.fontWeight} ${typography.fontSize}px ${typography.fontFamily}`
        const metrics = this.measureContext.measureText(XTermLineTimestampGutter.SAMPLE_TEXT)
        this.gutterWidthPx = Math.max(1, Math.ceil(Math.max(
            metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
            metrics.width,
        )))
        this.contentGapPx = Math.ceil(this.getCellWidth() * XTermLineTimestampGutter.CONTENT_GAP_COLUMNS)
        this.layoutInvalidated = false
        this.typographyKey = typographyKey
    }

    private getTypography (): { fontFamily: string, fontSize: number, fontWeight: string, letterSpacing: number } {
        const options = this.xterm.options as Terminal['options'] & { letterSpacing?: number }
        return {
            fontFamily: options.fontFamily ?? 'monospace',
            fontSize: Number(options.fontSize) || 14,
            fontWeight: `${options.fontWeight ?? 'normal'}`,
            letterSpacing: Number(options.letterSpacing) || 0,
        }
    }

    private installFontListeners (): void {
        const fonts = document.fonts
        fonts.addEventListener('loadingdone', this.fontLoadingListener)
        fonts.ready.then(() => this.fontLoadingListener()).catch(() => null)
    }

    private removeFontListeners (): void {
        document.fonts.removeEventListener('loadingdone', this.fontLoadingListener)
    }

    private getCellWidth (): number {
        const dimensions = this.getRenderDimensions()
        return dimensions?.css?.cell?.width || 8
    }

    private getCanvasFont (dpr: number): string {
        const typography = this.getTypography()
        return `${typography.fontWeight} ${typography.fontSize * dpr}px ${typography.fontFamily}`
    }

    private syncCanvasGeometry (): {
        dpr: number
        deviceWidth: number
        deviceHeight: number
        deviceCellHeight: number
        deviceCharHeight: number
        deviceCharTop: number
    } {
        const dimensions = this.getRenderDimensions()
        const dpr = dimensions?.css?.canvas?.height
            ? dimensions.device.canvas.height / dimensions.css.canvas.height
            : window.devicePixelRatio || 1
        const cssCellHeight = dimensions?.css?.cell?.height || this.getRowHeight()
        const deviceCellHeight = dimensions?.device?.cell?.height || Math.max(1, Math.round(cssCellHeight * dpr))
        const deviceCharHeight = dimensions?.device?.char?.height || Math.max(1, Math.round(this.getTypography().fontSize * dpr))
        const deviceCharTop = dimensions?.device?.char?.top ?? Math.max(0, Math.round((deviceCellHeight - deviceCharHeight) / 2))
        const deviceWidth = Math.max(1, Math.round(this.gutterWidthPx * dpr))
        const deviceHeight = Math.max(1, deviceCellHeight * this.xterm.rows)

        if (this.canvas) {
            if (this.canvas.width !== deviceWidth) {
                this.canvas.width = deviceWidth
            }
            if (this.canvas.height !== deviceHeight) {
                this.canvas.height = deviceHeight
            }
            this.canvas.style.width = `${this.gutterWidthPx}px`
            this.canvas.style.height = `${cssCellHeight * this.xterm.rows}px`
        }

        return {
            dpr,
            deviceWidth,
            deviceHeight,
            deviceCellHeight,
            deviceCharHeight,
            deviceCharTop,
        }
    }

    private clearCanvas (): void {
        if (!this.canvasContext || !this.canvas) {
            return
        }
        this.canvasContext.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }

    private isEffectivelyVisible (): boolean {
        if (!this.options.enabled) {
            return false
        }

        if (this.options.hideInAlternateScreen && this.xterm.buffer.active.type === 'alternate') {
            return false
        }

        return true
    }

    private getBufferByType (bufferType: XTermBufferType): any {
        return bufferType === 'alternate' ? this.xterm.buffer.alternate : this.xterm.buffer.normal
    }

    private formatTimestamp (timestamp: number): string {
        const date = new Date(timestamp)
        const hh = date.getHours().toString().padStart(2, '0')
        const mm = date.getMinutes().toString().padStart(2, '0')
        const ss = date.getSeconds().toString().padStart(2, '0')
        return `[${hh}:${mm}:${ss}]`
    }
}

/** @hidden */
export class XTermFrontend extends Frontend {
    enableResizing = true
    xterm: Terminal
    protected xtermCore: any
    protected enableWebGL = false
    private element?: HTMLElement
    private configuredFontSize = 0
    private configuredLinePadding = 0
    private zoom = 0
    private resizeHandler: () => void
    private configuredTheme: ITheme = {}
    private copyOnSelect = false
    private preventNextOnSelectionChangeEvent = false
    private search = new SearchAddon()
    private searchState: SearchState = { resultCount: 0 }
    private fitAddon = new FitAddon()
    private serializeAddon = new SerializeAddon()
    private ligaturesAddon?: LigaturesAddon
    private webGLAddon?: WebglAddon
    private canvasAddon?: CanvasAddon
    private opened = false
    private resizeObserver?: any
    private flowControl: FlowControl
    private lineTimestampGutter: XTermLineTimestampGutter
    private readonly fontLoadingListener = () => this.handleFontLoadingDone()

    private configService: ConfigService
    private hotkeysService: HotkeysService
    private platformService: PlatformService
    private hostApp: HostAppService
    private themes: ThemesService

    constructor (injector: Injector) {
        super(injector)
        this.configService = injector.get(ConfigService)
        this.hotkeysService = injector.get(HotkeysService)
        this.platformService = injector.get(PlatformService)
        this.hostApp = injector.get(HostAppService)
        this.themes = injector.get(ThemesService)

        this.xterm = new Terminal({
            allowTransparency: true,
            allowProposedApi: true,
            overviewRulerWidth: 8,
            windowsPty: process.platform === 'win32' ? {
                backend: this.configService.store.terminal.useConPTY ? 'conpty' : 'winpty',
                buildNumber: getWindows10Build(),
            } : undefined,
        })
        this.flowControl = new FlowControl(this.xterm)
        this.lineTimestampGutter = new XTermLineTimestampGutter(
            this.xterm,
            () => this.getRowHeight(),
            () => this.xtermCore?._renderService?.dimensions,
        )
        this.xtermCore = this.xterm['_core']

        this.xterm.onBinary(data => {
            this.input.next(Buffer.from(data, 'binary'))
        })
        this.xterm.onData(data => {
            this.input.next(Buffer.from(data, 'utf-8'))
        })
        this.xterm.onResize(({ cols, rows }) => {
            this.resize.next({ rows, columns: cols })
            if (this.lineTimestampGutter.isEnabled()) {
                this.lineTimestampGutter.renderVisibleRows()
            }
        })
        this.xterm.onTitleChange(title => {
            this.title.next(title)
        })
        this.xterm.onSelectionChange(() => {
            if (this.getSelection()) {
                if (this.copyOnSelect && !this.preventNextOnSelectionChangeEvent) {
                    this.copySelection()
                }
                this.preventNextOnSelectionChangeEvent = false
            }
        })
        this.xterm.onBell(() => {
            this.bell.next()
        })

        this.xterm.loadAddon(this.fitAddon)
        this.xterm.loadAddon(this.serializeAddon)
        this.xterm.loadAddon(new Unicode11Addon())
        this.xterm.unicode.activeVersion = '11'

        if (this.configService.store.terminal.sixel) {
            this.xterm.loadAddon(new ImageAddon())
        }

        const keyboardEventHandler = (name: string, event: KeyboardEvent) => {
            if (this.isAlternateScreenActive()) {
                let modifiers = 0
                modifiers += event.ctrlKey ? 1 : 0
                modifiers += event.altKey ? 1 : 0
                modifiers += event.shiftKey ? 1 : 0
                modifiers += event.metaKey ? 1 : 0
                if (event.key.startsWith('Arrow') && modifiers === 1) {
                    return true
                }
            }

            // Ctrl-/
            if (event.type === 'keydown' && event.key === '/' && event.ctrlKey) {
                this.input.next(Buffer.from('\u001f', 'binary'))
                return false
            }

            // Ctrl-@
            if (event.type === 'keydown' && event.key === '@' && event.ctrlKey) {
                this.input.next(Buffer.from('\u0000', 'binary'))
                return false
            }

            this.hotkeysService.pushKeyEvent(name, event)

            let ret = true
            if (this.hotkeysService.matchActiveHotkey(true) !== null) {
                event.stopPropagation()
                event.preventDefault()
                ret = false
            }
            return ret
        }

        this.xterm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
            if (this.hostApp.platform !== Platform.Web) {
                if (
                    event.getModifierState('Meta') && event.key.toLowerCase() === 'v' ||
                    event.key === 'Insert' && event.shiftKey
                ) {
                    event.preventDefault()
                    return false
                }
            }
            if (event.getModifierState('Meta') && event.key.startsWith('Arrow')) {
                return false
            }

            return keyboardEventHandler('keydown', event)
        })

        this.xtermCore._scrollToBottom = this.xtermCore.scrollToBottom.bind(this.xtermCore)
        this.xtermCore.scrollToBottom = () => null

        this.resizeHandler = () => {
            try {
                if (this.xterm.element && getComputedStyle(this.xterm.element).getPropertyValue('height') !== 'auto') {
                    this.lineTimestampGutter.invalidateLayout()
                    this.fitAddon.fit()
                    this.xterm.refresh(0, this.xterm.rows - 1)
                    if (this.lineTimestampGutter.isEnabled()) {
                        this.lineTimestampGutter.renderVisibleRows()
                    }
                }
            } catch (e) {
                // tends to throw when element wasn't shown yet
                console.warn('Could not resize xterm', e)
            }
        }

        const oldKeyUp = this.xtermCore._keyUp.bind(this.xtermCore)
        this.xtermCore._keyUp = (e: KeyboardEvent) => {
            this.xtermCore.updateCursorStyle(e)
            if (keyboardEventHandler('keyup', e)) {
                oldKeyUp(e)
            }
        }

        this.xterm.buffer.onBufferChange(() => {
            const altBufferActive = this.xterm.buffer.active.type === 'alternate'
            this.alternateScreenActive.next(altBufferActive)
            if (this.lineTimestampGutter.isEnabled()) {
                this.lineTimestampGutter.renderVisibleRows()
            }
        })
    }

    async attach (host: HTMLElement, profile: BaseTerminalProfile): Promise<void> {
        this.element = host

        this.xterm.open(host)
        this.opened = true
        this.lineTimestampGutter.attach(host)
        this.installFontListeners()

        // Work around font loading bugs
        await new Promise(resolve => setTimeout(resolve, this.hostApp.platform === Platform.Web ? 1000 : 0))

        // Just configure the colors to avoid a flash
        this.configureColors(profile.terminalColorScheme)

        if (this.enableWebGL) {
            this.webGLAddon = new WebglAddon()
            this.xterm.loadAddon(this.webGLAddon)
            this.platformService.displayMetricsChanged$.pipe(
                takeUntil(this.destroyed$),
            ).subscribe(() => {
                this.webGLAddon?.clearTextureAtlas()
            })
        } else {
            this.canvasAddon = new CanvasAddon()
            this.xterm.loadAddon(this.canvasAddon)
            this.platformService.displayMetricsChanged$.pipe(
                takeUntil(this.destroyed$),
            ).subscribe(() => {
                this.canvasAddon?.clearTextureAtlas()
            })
        }

        // Allow an animation frame
        await new Promise(r => setTimeout(r, 100))

        this.ready.next()
        this.ready.complete()

        this.xterm.loadAddon(this.search)

        this.search.onDidChangeResults(state => {
            this.searchState = state
        })

        window.addEventListener('resize', this.resizeHandler)

        this.resizeHandler()
        if (this.lineTimestampGutter.isEnabled()) {
            this.lineTimestampGutter.renderVisibleRows()
        }

        // Allow an animation frame
        await new Promise(r => setTimeout(r, 0))

        host.addEventListener('dragOver', (event: any) => this.dragOver.next(event))
        host.addEventListener('drop', event => this.drop.next(event))

        host.addEventListener('mousedown', event => this.mouseEvent.next(event))
        host.addEventListener('mouseup', event => this.mouseEvent.next(event))
        host.addEventListener('mousewheel', event => this.mouseEvent.next(event as MouseEvent))
        host.addEventListener('contextmenu', event => {
            event.preventDefault()
            event.stopPropagation()
        })

        this.resizeObserver = new window['ResizeObserver'](() => setTimeout(() => this.resizeHandler()))
        this.resizeObserver.observe(host)

        this.xterm.onScroll(() => {
            if (this.lineTimestampGutter.isEnabled()) {
                this.lineTimestampGutter.renderVisibleRows()
            }
        })
        this.xterm.onRender(() => {
            if (this.lineTimestampGutter.isEnabled()) {
                this.lineTimestampGutter.renderVisibleRows()
            }
        })
    }

    detach (_host: HTMLElement): void {
        window.removeEventListener('resize', this.resizeHandler)
        this.resizeObserver?.disconnect()
        delete this.resizeObserver
        this.removeFontListeners()
        this.lineTimestampGutter.detach()
    }

    destroy (): void {
        super.destroy()
        this.removeFontListeners()
        this.lineTimestampGutter.dispose()
        this.webGLAddon?.dispose()
        this.canvasAddon?.dispose()
        this.xterm.dispose()
    }

    getSelection (): string {
        return this.xterm.getSelection()
    }

    copySelection (): void {
        const text = this.getSelection()
        if (!text.trim().length) {
            return
        }
        if (text.length < 1024 * 32 && this.configService.store.terminal.copyAsHTML) {
            this.platformService.setClipboard({
                text: this.getSelection(),
                html: this.getSelectionAsHTML(),
            })
        } else {
            this.platformService.setClipboard({
                text: this.getSelection(),
            })
        }
    }

    selectAll (): void {
        this.xterm.selectAll()
    }

    clearSelection (): void {
        this.xterm.clearSelection()
    }

    focus (): void {
        setTimeout(() => this.xterm.focus())
    }

    async write (data: string, metadata?: TerminalWriteMetadata): Promise<void> {
        const timestamp = metadata?.lineTimestamp?.timestamp
        if (this.lineTimestampGutter.isEnabled()) {
            this.lineTimestampGutter.beforeWrite(timestamp)
        }
        await this.flowControl.write(data, !!timestamp)
        if (this.lineTimestampGutter.isEnabled()) {
            this.lineTimestampGutter.afterWrite()
            this.lineTimestampGutter.renderVisibleRows()
        }
    }

    clear (): void {
        this.xterm.clear()
        if (this.lineTimestampGutter.isEnabled()) {
            this.lineTimestampGutter.renderVisibleRows()
        }
    }

    visualBell (): void {
        if (this.element) {
            this.element.style.animation = 'none'
            setTimeout(() => {
                this.element!.style.animation = 'terminalShakeFrames 0.3s ease'
            })
        }
    }

    scrollToTop (): void {
        this.xterm.scrollToTop()
    }

    scrollPages (pages: number): void {
        this.xterm.scrollPages(pages)
    }

    scrollLines (amount: number): void {
        this.xterm.scrollLines(amount)
    }

    scrollToBottom (): void {
        this.xtermCore._scrollToBottom()
    }

    private configureColors (scheme: TerminalColorScheme|undefined): void {
        const appColorScheme = this.themes._getActiveColorScheme() as TerminalColorScheme

        scheme = scheme ?? appColorScheme

        const theme: ITheme = {
            foreground: scheme.foreground,
            selectionBackground: scheme.selection ?? '#88888888',
            selectionForeground: scheme.selectionForeground ?? undefined,
            background: getTerminalBackgroundColor(this.configService, this.themes, scheme) ?? '#00000000',
            cursor: scheme.cursor,
            cursorAccent: scheme.cursorAccent,
        }

        for (let i = 0; i < COLOR_NAMES.length; i++) {
            theme[COLOR_NAMES[i]] = scheme.colors[i]
        }

        if (!deepEqual(this.configuredTheme, theme)) {
            this.xterm.options.theme = theme
            this.configuredTheme = theme
        }
    }

    configure (profile: BaseTerminalProfile): void {
        const config = this.configService.store

        setImmediate(() => {
            if (this.xterm.cols && this.xterm.rows && this.xtermCore.charMeasure) {
                if (this.xtermCore.charMeasure) {
                    this.xtermCore.charMeasure.measure(this.xtermCore.options)
                }
                if (this.xtermCore.renderer) {
                    this.xtermCore.renderer._updateDimensions()
                }
                this.resizeHandler()
            }
        })

        this.xtermCore.browser.isWindows = this.hostApp.platform === Platform.Windows
        this.xtermCore.browser.isLinux = this.hostApp.platform === Platform.Linux
        this.xtermCore.browser.isMac = this.hostApp.platform === Platform.macOS

        this.xterm.options.fontFamily = getCSSFontFamily(config)
        this.xterm.options.cursorStyle = {
            beam: 'bar',
        }[config.terminal.cursor] || config.terminal.cursor
        this.xterm.options.cursorBlink = config.terminal.cursorBlink
        this.xterm.options.macOptionIsMeta = config.terminal.altIsMeta
        this.xterm.options.scrollback = config.terminal.scrollbackLines
        this.xterm.options.wordSeparator = config.terminal.wordSeparator
        this.xterm.options.drawBoldTextInBrightColors = config.terminal.drawBoldTextInBrightColors
        this.xterm.options.fontWeight = config.terminal.fontWeight
        this.xterm.options.fontWeightBold = config.terminal.fontWeightBold
        this.xterm.options.minimumContrastRatio = config.terminal.minimumContrastRatio
        this.configuredFontSize = config.terminal.fontSize
        this.configuredLinePadding = config.terminal.linePadding
        this.lineTimestampGutter.invalidateLayout()
        this.setFontSize()

        this.copyOnSelect = config.terminal.copyOnSelect

        this.configureColors(profile.terminalColorScheme)
        if (this.lineTimestampGutter.isEnabled()) {
            this.lineTimestampGutter.renderVisibleRows()
        }

        if (this.opened && config.terminal.ligatures && !this.ligaturesAddon && this.hostApp.platform !== Platform.Web) {
            this.ligaturesAddon = new LigaturesAddon()
            this.xterm.loadAddon(this.ligaturesAddon)
        }
    }

    setZoom (zoom: number): void {
        this.zoom = zoom
        this.setFontSize()
        this.resizeHandler()
    }

    setLineTimestampOptions (options: TerminalLineTimestampOptions): void {
        this.lineTimestampGutter.setOptions(options)
    }

    private getSearchOptions (searchOptions?: SearchOptions): ISearchOptions {
        return {
            ...searchOptions,
            decorations: {
                matchOverviewRuler: '#888888',
                activeMatchColorOverviewRuler: '#ffff00',
                matchBackground: '#888888',
                activeMatchBackground: '#ffff00',
            },
        }
    }

    private wrapSearchResult (result: boolean): SearchState {
        if (!result) {
            return { resultCount: 0 }
        }
        return this.searchState
    }

    findNext (term: string, searchOptions?: SearchOptions): SearchState {
        if (this.copyOnSelect) {
            this.preventNextOnSelectionChangeEvent = true
        }
        return this.wrapSearchResult(
            this.search.findNext(term, this.getSearchOptions(searchOptions)),
        )
    }

    findPrevious (term: string, searchOptions?: SearchOptions): SearchState {
        if (this.copyOnSelect) {
            this.preventNextOnSelectionChangeEvent = true
        }
        return this.wrapSearchResult(
            this.search.findPrevious(term, this.getSearchOptions(searchOptions)),
        )
    }

    cancelSearch (): void {
        this.search.clearDecorations()
        this.focus()
    }

    saveState (): any {
        return this.serializeAddon.serialize({
            excludeAltBuffer: true,
            excludeModes: true,
            scrollback: 1000,
        })
    }

    restoreState (state: string): void {
        this.xterm.write(state)
    }

    supportsBracketedPaste (): boolean {
        return this.xterm.modes.bracketedPasteMode
    }

    isAlternateScreenActive (): boolean {
        return this.xterm.buffer.active.type === 'alternate'
    }

    private setFontSize () {
        const scale = Math.pow(1.1, this.zoom)
        this.xterm.options.fontSize = this.configuredFontSize * scale
        // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
        this.xterm.options.lineHeight = Math.max(1, (this.configuredFontSize + this.configuredLinePadding * 2) / this.configuredFontSize)
        this.lineTimestampGutter.invalidateLayout()
        this.resizeHandler()
        if (this.lineTimestampGutter.isEnabled()) {
            this.lineTimestampGutter.renderVisibleRows()
        }
    }

    private installFontListeners (): void {
        document.fonts.addEventListener('loadingdone', this.fontLoadingListener)
        document.fonts.ready.then(() => this.handleFontLoadingDone()).catch(() => null)
    }

    private removeFontListeners (): void {
        document.fonts.removeEventListener('loadingdone', this.fontLoadingListener)
    }

    private handleFontLoadingDone (): void {
        if (!this.opened || !this.xterm.cols || !this.xterm.rows) {
            return
        }

        this.webGLAddon?.clearTextureAtlas()
        this.canvasAddon?.clearTextureAtlas()
        this.lineTimestampGutter.invalidateLayout()

        if (this.xtermCore?.charMeasure) {
            this.xtermCore.charMeasure.measure(this.xtermCore.options)
        }
        if (this.xtermCore?.renderer) {
            this.xtermCore.renderer._updateDimensions()
        }

        this.resizeHandler()
        this.xterm.refresh(0, this.xterm.rows - 1)
        if (this.lineTimestampGutter.isEnabled()) {
            this.lineTimestampGutter.renderVisibleRows()
        }
    }

    private getSelectionAsHTML (): string {
        return this.serializeAddon.serializeAsHTML({ includeGlobalBackground: true, onlySelection: true  })
    }

    private getRowHeight (): number {
        return this.xtermCore?._renderService?.dimensions?.css?.cell?.height
            ?? this.configuredFontSize * (typeof this.xterm.options.lineHeight === 'number' ? this.xterm.options.lineHeight : 1)
            ?? 20
    }
}

/** @hidden */
export class XTermWebGLFrontend extends XTermFrontend {
    protected enableWebGL = true
}
