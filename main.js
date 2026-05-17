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

        this.on('ready',              this.onReady.bind(this));
        this.on('stateChange',        this.onStateChange.bind(this));
        this.on('foreignStateChange', this.onForeignStateChange.bind(this));
        this.on('unload',             this.onUnload.bind(this));
    }

    async onReady() {
        const rules = this.config.rules || [];
        const activeRules = rules.filter(r => r.enabled && r.sourceId && r.targetId);

        if (activeRules.length === 0) {
            this.log.info('Keine aktiven Umrechnungsregeln konfiguriert.');
            return;
        }

        for (const rule of activeRules) {
            await this._ensureTargetObject(rule);
            await this.subscribeForeignStatesAsync(rule.sourceId);
            this.log.debug(`Abonniert: "${rule.sourceId}" → "${this.namespace}.${rule.targetId}"`);
        }

        this.log.info(`${activeRules.length} Regel(n) aktiv.`);
    }

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

    async onForeignStateChange(id, state) {
        if (!state) return;

        const rules = (this.config.rules || []).filter(
            r => r.enabled && r.sourceId === id,
        );

        for (const rule of rules) {
            const result = this._applyConversion(rule, state.val);
            if (result === null) continue;

            await this.setStateAsync(rule.targetId, { val: result, ack: true });
            this.log.debug(`${id} = ${state.val} → ${rule.targetId} = ${result}`);
        }
    }

    onStateChange(id, state) {
        // Eigene States werden nicht verarbeitet
        void id; void state;
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
                // new Function begrenzt den Scope; "use strict" verhindert globalem Zugriff
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

    onUnload(callback) {
        try {
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    // Compact mode export
    module.exports = (options) => new Changer(options);
} else {
    new Changer();
}
