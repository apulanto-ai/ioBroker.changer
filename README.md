# ioBroker Changer

Ein ioBroker-Adapter, der beliebige States einliest, eine konfigurierbare Umrechnungsformel anwendet und das Ergebnis als neuen State schreibt.

## Funktionen

- Mehrere Umrechnungsregeln pro Instanz
- Echtzeit-Reaktion bei State-Änderungen (kein Polling)
- Vordefinierte Umrechnungen: Wh↔kWh, W↔kW, °F↔°C, K↔°C, m/s↔km/h, %↔Dezimal
- Eigene JavaScript-Formeln (Variable `value` für den Eingangswert)
- Konfiguration über das ioBroker-Admin-UI

## Konfiguration

Im Admin-UI unter der Instanz können beliebig viele Regeln angelegt werden:

| Feld | Beschreibung |
|---|---|
| **Aktiv** | Regel ein-/ausschalten |
| **Quell-State-ID** | Vollständige ID des zu lesenden States, z.B. `hm-rpc.0.ABC.1.TEMPERATURE` |
| **Umrechnung** | Vordefinierte Umrechnung oder „Eigene Formel" |
| **Eigene Formel** | JS-Ausdruck mit `value` als Variable, z.B. `value * 0.001` |
| **Ziel-State-ID** | Name des erzeugten States (relativ zur Instanz), z.B. `converted.temperature` |
| **Einheit** | Einheit des Ziel-States, z.B. `kWh` |

Der erzeugte State ist dann unter `changer.0.<Ziel-State-ID>` erreichbar.

## Beispiele für eigene Formeln

```
value / 1000                        → Wh in kWh
Math.round(value * 10) / 10        → Auf eine Nachkommastelle runden
value > 0 ? value : 0              → Negative Werte auf 0 klemmen
(value - 32) / 1.8                 → Fahrenheit in Celsius
```

## Installation

```bash
# In ioBroker-Admin: Adapter aus GitHub-URL installieren
# URL: https://github.com/apulanto/iobroker-changer
```

## Lizenz

MIT
