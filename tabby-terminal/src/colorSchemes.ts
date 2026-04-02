import { Injectable } from '@angular/core'
import { TerminalColorScheme } from './api/interfaces'
import { TerminalColorSchemeProvider } from './api/colorSchemeProvider'

@Injectable({ providedIn: 'root' })
export class DefaultColorSchemes extends TerminalColorSchemeProvider {
    static defaultColorScheme: TerminalColorScheme = {
        name: 'Tabby Default',
        foreground: '#cacaca',
        background: '#171717',
        cursor: '#bbbbbb',
        colors: [
            '#000000',
            '#ff615a',
            '#b1e969',
            '#ebd99c',
            '#5da9f6',
            '#e86aff',
            '#82fff7',
            '#dedacf',
            '#313131',
            '#f58c80',
            '#ddf88f',
            '#eee5b2',
            '#a5c7ff',
            '#ddaaff',
            '#b7fff9',
            '#ffffff',
        ],
        selection: undefined,
        cursorAccent: undefined,
    }

    static defaultLightColorScheme: TerminalColorScheme = {
        name: 'Tabby Default Light',
        foreground: '#4d4d4c',
        background: '#ffffff',
        cursor: '#4d4d4c',
        colors: [
            '#000000',
            '#c82829',
            '#718c00',
            '#eab700',
            '#4271ae',
            '#8959a8',
            '#3e999f',
            '#ffffff',
            '#000000',
            '#c82829',
            '#718c00',
            '#eab700',
            '#4271ae',
            '#8959a8',
            '#3e999f',
            '#ffffff',
        ],
        selection: undefined,
        cursorAccent: undefined,
    }

    static termiusDarkColorScheme: TerminalColorScheme = {
        name: 'Termius Dark',
        foreground: '#4FAF68',
        background: '#141728',
        cursor: '#92A0A7',
        colors: [
            '#141728',
            '#E05B57',
            '#4FAF68',
            '#E7EBED',
            '#225388',
            '#EE7B79',
            '#478FEF',
            '#D6DDE0',
            '#5A5E73',
            '#E16866',
            '#4FAF68',
            '#FFFFFF',
            '#346BAF',
            '#EE7B79',
            '#5D9FEF',
            '#FFFFFF',
        ],
        selection: '#FFFFFF33',
        selectionForeground: undefined,
        cursorAccent: '#141728',
    }

    async getSchemes (): Promise<TerminalColorScheme[]> {
        return [
            DefaultColorSchemes.defaultColorScheme,
            DefaultColorSchemes.defaultLightColorScheme,
            DefaultColorSchemes.termiusDarkColorScheme,
        ]
    }
}
