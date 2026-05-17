'use strict';

const utils = require('@iobroker/adapter-core');

const PREDEFINED_FORMULAS = {
    wh_kwh:             v => v / 1000,
    kwh_wh:             v => v * 1000,
    w_kw:               v => v / 1000,
    kw_w:               v => v * 1000,
    fahrenheit_celsius: v => (v - 32) / 1.8,
    celsius_fahrenheit: v => v * 1.8 + 32,
    kelvin_celsius:     v => v - 273.15,
    celsius_kelvin:     v => v + 273.15,
    ms_kmh:             v => v * 3.6,
    kmh_ms:             v => v / 3.6,
    percent_fraction:   v => v / 100,
    fraction_percent:   v => v * 100,
};

class Changer extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'changer',
        });

        // VPD: letzte bekannte Eingangsewerte zwischenspeichern
        this._vpdTemp = null;
        this._vpdHum  = null;

        this.on('ready',              this.onReady.bind(this));
        this.on('stateChange',        this.onStateChange.bind(this));
        this.on('foreignStateChange', this.onForeignStateChange.bind(this));
        this.on('unload',             this.onUnload.bind(this));
    }

    async onReady() {
        const rules      = this.config.rules || [];
        const activeRules = rules.filter(r => r.enabled && r.sourceId && r.targetId);

        for (const rule of activeRules) {
            await this._ensureTargetObject(rule);
            await this.subscribeForeignStatesAsync(rule.sourceId);
            this.log.debug(`Abonniert: "${rule.sourceId}" → "${this.namespace}.${rule.targetId}"`);
        }

        if (activeRules.length > 0) {
            this.log.info(`${activeRules.length} Umrechnungsregel(n) aktiv.`);
        }

        await this._initVpd();
    }

    // ── Umrechnung ────────────────────────────────────────────────────────────

    async _ensureTargetObject(rule) {
        await this.setObjectNotExistsAsync(rule.targetId, {
            type: 'state',
            common: {
                name:  `Umgerechnet: ${rule.sourceId}`,
                type:  'number',
                role:  'value',
                read:  true,
                write: false,
                unit:  rule.unit || '',
            },
            native: {
                sourceId:   rule.sourceId,
                conversion: rule.conversion,
            },
        });
    }

    _applyConversion(rule, value) {
        if (value === null || value === undefined || typeof value !== 'number') {
            this.log.warn(`Überspringe Regel "${rule.targetId}": Wert ist kein numerischer Wert (${JSON.stringify(value)})`);
            return null;
        }

        try {
            if (rule.conversion === 'custom') {
                if (!rule.customFormula || !rule.customFormula.trim()) {
                    this.log.warn(`Regel "${rule.targetId}": Eigene Formel ist leer.`);
                    return null;
                }
                const fn = new Function('value', 'Math', `"use strict"; return (${rule.customFormula});`);
                const result = fn(value, Math);
                if (typeof result !== 'number' || !isFinite(result)) {
                    this.log.warn(`Regel "${rule.targetId}": Formel lieferte keinen gültigen Zahlenwert: ${result}`);
                    return null;
                }
                return result;
            }

            const fn = PREDEFINED_FORMULAS[rule.conversion];
            if (!fn) {
                this.log.warn(`Regel "${rule.targetId}": Unbekannte Umrechnung "${rule.conversion}".`);
                return null;
            }
            return fn(value);
        } catch (err) {
            this.log.error(`Fehler bei Umrechnung für "${rule.targetId}": ${err.message}`);
            return null;
        }
    }

    // ── VPD ──────────────────────────────────────────────────────────────────

    async _initVpd() {
        const cfg = this.config;
        if (!cfg.vpdEnabled || !cfg.vpdTempId || !cfg.vpdHumId || !cfg.vpdTargetId) {
            return;
        }

        await this.setObjectNotExistsAsync(cfg.vpdTargetId, {
            type: 'state',
            common: {
                name:  'VPD (Sättigungsdefizit)',
                type:  'number',
                role:  'value',
                read:  true,
                write: false,
                unit:  'kPa',
            },
            native: {
                tempId: cfg.vpdTempId,
                humId:  cfg.vpdHumId,
            },
        });

        await this.subscribeForeignStatesAsync(cfg.vpdTempId);
        await this.subscribeForeignStatesAsync(cfg.vpdHumId);

        // Startwerte einlesen damit sofort ein VPD berechnet werden kann
        const tempState = await this.getForeignStateAsync(cfg.vpdTempId);
        const humState  = await this.getForeignStateAsync(cfg.vpdHumId);

        if (tempState && typeof tempState.val === 'number') this._vpdTemp = tempState.val;
        if (humState  && typeof humState.val  === 'number') this._vpdHum  = humState.val;

        await this._calculateAndWriteVpd();
        this.log.info(`VPD-Berechnung aktiv: T="${cfg.vpdTempId}", RH="${cfg.vpdHumId}" → "${this.namespace}.${cfg.vpdTargetId}"`);
    }

    async _calculateAndWriteVpd() {
        const T  = this._vpdTemp;
        const RH = this._vpdHum;

        if (typeof T !== 'number' || typeof RH !== 'number') return;
        if (!isFinite(T) || !isFinite(RH)) return;

        // Sättigungsdampfdruck (Magnus-Formel) in kPa
        const svp = 0.6108 * Math.exp(17.27 * T / (T + 237.3));
        // VPD = SVP * (1 – relative Feuchte)
        const vpd = Math.round(svp * (1 - RH / 100) * 1000) / 1000;

        await this.setStateAsync(this.config.vpdTargetId, { val: vpd, ack: true });
        this.log.debug(`VPD: T=${T}°C, RH=${RH}% → SVP=${svp.toFixed(4)} kPa → VPD=${vpd} kPa`);
    }

    // ── Events ────────────────────────────────────────────────────────────────

    async onForeignStateChange(id, state) {
        if (!state) return;

        // Umrechnungsregeln
        const rules = (this.config.rules || []).filter(r => r.enabled && r.sourceId === id);
        for (const rule of rules) {
            const result = this._applyConversion(rule, state.val);
            if (result === null) continue;
            await this.setStateAsync(rule.targetId, { val: result, ack: true });
            this.log.debug(`${id} = ${state.val} → ${rule.targetId} = ${result}`);
        }

        // VPD
        const cfg = this.config;
        if (cfg.vpdEnabled && cfg.vpdTempId && cfg.vpdHumId) {
            if (id === cfg.vpdTempId && typeof state.val === 'number') {
                this._vpdTemp = state.val;
                await this._calculateAndWriteVpd();
            } else if (id === cfg.vpdHumId && typeof state.val === 'number') {
                this._vpdHum = state.val;
                await this._calculateAndWriteVpd();
            }
        }
    }

    onStateChange(id, state) {
        void id; void state;
    }

    onUnload(callback) {
        try {
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Changer(options);
} else {
    new Changer();
}
