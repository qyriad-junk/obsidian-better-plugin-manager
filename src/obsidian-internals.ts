import { App, EventRef, ExtraButtonComponent, PluginManifest, Workspace } from "obsidian";

export type TranslationVars = Record<string, string | number | boolean | null | undefined>;

export type ExtraButtonComponentWithEl = ExtraButtonComponent & {
    extraSettingsEl?: HTMLElement;
    buttonEl?: HTMLElement;
};

export function getExtraButtonElement(button: ExtraButtonComponent): HTMLElement | undefined {
    const component = button as ExtraButtonComponentWithEl;
    return component.extraSettingsEl || component.buttonEl;
}

export type AppPluginInstanceLike = {
    manifest?: PluginManifest & {
        pluginUrl?: string;
        author2?: string;
        installLink?: string;
    };
    [key: string]: unknown;
};

/**
 * Obsidian's internal PluginManager (`app.plugins`). Semantics verified against Obsidian 1.13.7; see
 * docs/codebase-notes.md. Outside src/plugin-startup.ts, prefer going through PluginStartup.
 */
export type ObsidianPluginRegistry = {
    manifests: Record<string, PluginManifest>;
    /** The persisted startup list (community-plugins.json), *not* what's currently running. */
    enabledPlugins: Set<string>;
    /** What's currently running. */
    plugins?: Record<string, AppPluginInstanceLike>;
    installPlugin: (repo: string, version: string, manifest: PluginManifest | Record<string, unknown>) => Promise<void>;
    uninstallPlugin: (id: string) => Promise<void>;
    loadManifests: () => Promise<void>;
    loadPlugin: (id: string) => Promise<void>;
    /** Loads the plugin; false if Obsidian refused (unknown manifest, restricted mode, blocklisted, desktop-only…). */
    enablePlugin: (id: string, userEnable?: boolean) => Promise<boolean>;
    disablePlugin: (id: string, userDisable?: boolean) => Promise<void>;
    enablePluginAndSave: (id: string) => Promise<boolean>;
    disablePluginAndSave: (id: string) => Promise<void>;
    /** Writes `Array.from(enabledPlugins)` to community-plugins.json. */
    saveConfig: () => Promise<void>;
    on: (name: "changed", callback: () => void) => EventRef;
    offref: (ref: EventRef) => void;
};

export type SettingTabLike = {
    searchComponent?: { inputEl: HTMLInputElement };
    updateHotkeyVisibility?: () => void;
    containerEl?: HTMLElement;
};

export type ActiveTabLike = SettingTabLike & {
    searchComponent: { inputEl: HTMLInputElement };
    updateHotkeyVisibility: () => void;
};

export type AppSettingsLike = {
    activeTab?: ActiveTabLike;
    open: () => Promise<void>;
    openTabById: (id: string) => Promise<void>;
};

export type ObsidianAppWithInternals = App & {
    plugins: ObsidianPluginRegistry;
    setting: AppSettingsLike;
    i18n?: {
        locale?: string;
        lang?: string;
        language?: string;
    };
};

export type RibbonNativeItem = {
    id?: string;
    title?: string;
    name?: string;
    ariaLabel?: string;
    icon?: string;
};

export type LeftRibbonLike = {
    items?: Array<RibbonNativeItem | null | undefined>;
    /** `hiddenItems` key order is the ribbon order. */
    serialize(): { hiddenItems: Record<string, boolean> };
    /** Applies hidden flags and order to the items that exist right now; others are ignored. */
    load(layout: { hiddenItems: Record<string, boolean> }): void;
};

export type WorkspaceWithRibbon = Workspace & {
    leftRibbon?: LeftRibbonLike;
};

export type VaultAdapterWithBasePath = {
    getBasePath?: () => string;
};

export type WindowWithMoment = Window & {
    moment?: {
        locale?: () => string;
    };
};
