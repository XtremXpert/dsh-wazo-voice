# dsh-wazo-voice

Faire parler une session **DeepSeek Harness** au téléphone, par un PBX
**Wazo / Asterisk**, en AudioSocket, avec transcription et synthèse locales.

> English version: `README.en.md`.

## Le besoin que ce module comble

Les solutions existantes qui branchent un agent IA sur un PBX supposent toutes
quelque chose que nous n'avons pas, ou nous coûtent quelque chose que nous ne
voulons pas payer :

| Ce dont on a besoin | Pourquoi les autres ne le donnent pas |
|:--|:--|
| **AudioSocket pur** | AVA en fait son transport principal, mais exige aussi ARI/Stasis et ne se publie qu'en x86 ; AVR ne publie que le core en binaire amd64 ; Pipecat vise `chan_websocket` ; LiveKit impose SIP + WebRTC. |
| **Tourner en ARM natif** | AVA et AVR sont x86 seulement. Sur un Mac Apple Silicon, l'émulation fausse la latence et le barge-in, c'est-à-dire justement ce qu'on mesure. |
| **La conversation = une vraie session d'agent** | AVA et AVR veulent tenir le LLM eux-mêmes : on rebrancherait notre agent derrière un endpoint OpenAI-compatible, en perdant la main sur ses outils et sa mémoire. |
| **Tout en local** | Whisper en transcription (port 9030) et Kokoro en synthèse (port 9032), sans clé ni fournisseur cloud. |
| **Écrire ET parler dans la même conversation** | Une réponse tapée pendant l'appel doit s'entendre sur la ligne : ce n'est le cas d'aucune des solutions comparées. |
| **Meubler la réflexion** | Une musique d'attente pendant que l'agent cherche, plutôt que du silence. |

C'est ce faisceau qui n'est comblé nulle part ailleurs : un pont **AudioSocket
mince**, **ARM natif**, qui **branche un agent déjà outillé** au lieu de le
réimplémenter, et qui **garde l'audio chez soi**.

## Ce qu'il n'est pas

- **Pas de barge-in.** Quand l'agent parle, l'audio entrant est ignoré (compté
  dans `dropped`) : on ne peut pas l'interrompre, et un énoncé commencé pendant
  la synthèse arrive tronqué. C'est la limite connue, assumée, et le premier
  chantier si le module doit servir hors de ce contexte.
- **Pas multi-PBX.** Il vise le plan de numérotation Wazo/Asterisk et son
  AudioSocket (`slin`, 8 kHz, 16 bits mono).
- **Pas un framework.** Pas de pipeline configurable, pas de fournisseurs
  interchangeables : trois services injectés (`asr`, `tts`, `agents`) et des
  outils exposés à l'agent.

## Comment ça marche

```
Asterisk ──AudioSocket──> VoiceBridge ──> CallSession (1 socket = 1 appel)
                                             │  VAD maison
                                             ├─> ASR local  (Whisper, 9030)
                                             ├─> AgentBridge ──> session DSH
                                             │      (outils, mémoire, preset)
                                             └─> TTS local  (Kokoro, 9032)
```

- `lib/bridge.js` écoute les ports AudioSocket, compose par AMI et expose l'état.
- `lib/calls.js` trame 20 ms à l'heure du protocole, détecte les énoncés,
  conduit le tour, joue la musique d'attente et les extraits.
- `lib/agent.js` crée ou reprend la session d'appel, pose la consigne d'oralité,
  et reprend les réponses **écrites** pour les faire dire sur la ligne.
- `lib/hold-music.js` fournit la boucle d'attente : un WAV fourni, ou une boucle
  synthétisée par défaut.

## Outils exposés à l'agent

| Outil | Rôle |
|:--|:--|
| `wazo_voice_call` | Compose un poste ou un numéro par AMI. |
| `wazo_voice_say` | Fait dire une phrase sans passer par l'agent. |
| `wazo_voice_play` | Joue un extrait d'un WAV sur la ligne. |
| `wazo_voice_hangup` | Raccroche après les adieux, sans couper la phrase en cours. |
| `wazo_voice_status` | Ports, appel en cours, dernier appel, santé ASR/TTS, secret AMI. |
| `wazo_voice_configure` | Enregistre le secret AMI dans le magasin de justificatifs. |

## Installation

Le module est un bundle local du profil DSH :

```json
{ "dependencies": { "@local/dsh-wazo-voice": "link:/chemin/vers/dsh-wazo-voice" },
  "dsh": { "profile": { "bundles": ["@local/dsh-wazo-voice"] } } }
```

Puis, dans le plan de numérotation Wazo, appeler
`AudioSocket(uuid,hôte:port)` vers un des ports écoutés.

## Configuration

Défauts dans `lib/config.js`, surchargeables par la rangée `wazo-voice` du
profil :

| Clé | Défaut | Sens |
|:--|:--|:--|
| `ports` | `[8092, 8090]` | Ports AudioSocket écoutés. |
| `asr.url` | `http://127.0.0.1:9030/` | Transcription locale. |
| `tts.url` | `http://127.0.0.1:9032/synthesize` | Synthèse locale (Kokoro). |
| `ami.host` | `192.168.234.60` | PBX pour les appels sortants. |
| `holdMusic.file` | `''` | WAV PCM 16 bits mono 8 kHz ; vide = boucle synthétisée. |
| `maxCallMs` | `1800000` | Garde-fou d'un appel oublié. |

## Tests

```sh
node --test test/*.test.mjs
```

## Licence

MIT (voir `LICENSE`).

Les extraits audio ne sont pas versionnés : voir `assets/README.md`. L'extrait
livré avec Asterisk (FreePlay) reste réservé à l'usage du PBX et n'est pas
redistribuable ; les enregistrements du domaine public (Satie, Joplin) le
sont.
