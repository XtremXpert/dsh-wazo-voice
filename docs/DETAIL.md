# Voix Wazo

Une conversation vocale réelle entre un humain au téléphone et l'agent du
Harness, sur un PBX **Wazo**. Le plugin tient les deux sens du média : il
entend (transcription), il parle (synthèse), et c'est **la session d'agent**
qui répond — pas une façade HTTP.

## Comment un appel arrive

```
poste 1000 ──► Wazo (plan de numérotation) ──► AudioSocket ──► ce plugin
                                                                  │
                                          transcription (ASR local) │
                                                                  ▼
                                                   session d'agent dédiée
                                                                  │
                                              synthèse (TTS local) │
                                                                  ▼
poste 1000 ◄── Wazo ◄── trames PCM 20 ms ◄────────────────────────┘
```

- **Entrant** : composer l'extension câblée sur `AudioSocket(uuid, hôte:port)`
  dans le plan de numérotation Wazo (extension `1099` dans le contexte interne
  Maison). L'accueil est facultatif (`greet.inbound`).
- **Sortant** : `wazo_voice_call` compose par **AMI** et fait exécuter
  l'application `AudioSocket` **sur le canal composé** : Asterisk sonne le
  poste puis, au décrochage, ouvre directement l'AudioSocket vers ce plugin.
  Un seul canal, aucun contexte du plan de numérotation à connaître. La phrase
  `opening` est prononcée dès le décrochage.

Le plugin écoute sur **deux ports** par défaut (8092 et 8090) parce que le plan
de numérotation déployé a utilisé l'un puis l'autre. Un port occupé est
signalé ; l'autre continue.

## Outils exposés à l'agent

| Outil | Rôle |
|---|---|
| `wazo_voice_call` | Appelle un poste (`to`, `opening`) et parle à qui décroche. |
| `wazo_voice_status` | Ports écoutés, appel en cours, dernier appel, ASR/TTS disponibles, secret AMI présent. |
| `wazo_voice_say` | Dit une phrase sur l'appel en cours, hors tour de l'agent. |
| `wazo_voice_hangup` | Raccroche l'appel en cours. |
| `wazo_voice_configure` | Enregistre le secret AMI dans le magasin de justificatifs (jamais dans la config). |

La session d'appel est **dédiée** (`agent.sessionId`, défaut `wazo-voice`) : un
appel ne détourne pas la conversation de travail. Elle emprunte le preset de
l'agent qui a demandé l'appel, et reçoit une consigne d'oralité (phrases
courtes, sans markdown) posée sur son propre contexte.

## Prérequis

1. **Wazo** joignable depuis le hôte du Harness, avec dans le plan de
   numérotation une extension qui appelle
   `AudioSocket(${UUID()}, <ip-du-hôte>:<port>)` puis `Hangup()`.
2. **Transcription** : service local (défaut `http://127.0.0.1:9030/`), contrat
   `POST /?language=fr` avec du PCM int16-LE mono 8 kHz brut, réponse
   `{ "text": … }`.
3. **Synthèse** : service local (défaut `http://127.0.0.1:9032/synthesize`),
   `{ text, voice, speed }` → `audio/wav`, ramené au 8 kHz par le plugin. Repli
   `say` + `afconvert` (macOS) si Kokoro ne répond pas.
4. **AMI** (appels sortants uniquement) : un utilisateur AMI sur le PBX. Son
   secret se pose avec `wazo_voice_configure`, ou par la variable
   d'environnement nommée par `ami.secretRef` (défaut `WAZO_AMI_SECRET`).
   L'adresse que le PBX doit joindre est détectée par la route vers `ami.host` ;
   `ami.advertiseHost` la fixe si la détection ne convient pas.

## Réglage

La config se lit dans la rangée `wazo-voice` du profil
(`~/.dsh/profiles/desktop/cordis.patch.yml`). Le paquet n'impose pas de schéma :
les valeurs par défaut sont dans `lib/config.js`, et seules les différences ont
besoin d'être écrites.

```yaml
- insert:
    - id: wazo-voice
      name: '@local/dsh-wazo-voice'
      config:
        ports: [8092]
        asr: { url: 'http://127.0.0.1:9030/', language: 'fr' }
        tts: { voice: 'ff_siwis' }
        ami:
          host: 192.168.234.60
          user: dsh
          channelTemplate: 'PJSIP/{to}'
          # context/exten ne servent que si application vaut '' (forme historique).
```

## Limites connues

- **Pas de barge-in** : quand l'agent parle, l'audio entrant est ignoré (compté
  dans `dropped`) pour que la synthèse ne soit pas transcrite. Parler par-dessus
  la réponse est donc perdu, et un énoncé commencé pendant la synthèse arrive
  tronqué — d'où des transcriptions parfois fautives. Attendre la fin de la
  phrase de l'agent est la bonne façon de parler.
- **Raccrochage** : l'agent doit appeler `wazo_voice_hangup` ; sinon la ligne
  reste ouverte jusqu'à ce que l'humain raccroche. Le raccrochage demandé
  pendant un tour attend la fin de la phrase en cours.
- **Une ligne à la fois** : un seul appel actif ; `wazo_voice_call` refuse
  pendant un appel.
- **Latence** : le tour est séquentiel (fin d'énoncé → transcription → agent →
  synthèse). Une réponse qui appelle des outils prend le temps des outils ;
  `wazo_voice_say` permet d'annoncer l'attente.
- **8 kHz** : bande passante téléphonique ; la transcription puis la synthèse
  gardent cette qualité, sans modèle embarqué.
- **`Originate` n'est pas un décrochage** : la réponse AMI prouve la mise en
  file. La preuve du décrochage est la connexion AudioSocket, visible dans
  `wazo_voice_status` (`active`).
- **Pas de transfert, de mise en attente ni de DTMF** : hors périmètre.
- **Un seul PBX** : le canal (`PJSIP/{to}`), l'utilisateur AMI et l'adresse
  publiée viennent de la config, pas d'une découverte automatique.

## Vérification

`node --test test/*.test.mjs` couvre 30 cas : cadrage AudioSocket fragmenté,
détection de parole, rééchantillonnage 24 kHz → 8 kHz, client AMI sur un
serveur simulé (dont `Application`/`Data`), et un **bouclage complet** (client
AudioSocket synthétique → ASR → agent → synthèse → trames de 20 ms), entrant et
sortant.

L'appel réel dépend du PBX et d'un combiné : il se vérifie sur le terrain, pas
en test unitaire.
