# Pistes audio

Les fichiers audio ne sont pas versionnés (voir `.gitignore`) : ils se
reconstituent avec les commandes ci-dessous, qui supposent `ffmpeg`.

## Musique d'attente par défaut : l'extrait Asterisk

Asterisk livre « macroform-cold_day » dans son dossier de musique d'attente.
FreePlay en réserve l'usage au PBX : recopier le fichier localement, ne pas le
redistribuer.

```sh
scp root@<pbx>:/usr/share/asterisk/moh/default/macroform-cold_day.wav \
  assets/attente-source.wav
```

Le fichier est déjà en PCM 16 bits mono 8 kHz : `holdMusic.file` peut le lire
tel quel.

## Extraits du domaine public (pour comparer)

Enregistrements du domaine public sur Wikimedia Commons, convertis à la
fréquence du canal.

```sh
curl -sSL -o satie.ogg "https://upload.wikimedia.org/wikipedia/commons/9/90/Erik_Satie_-_gymnopedies_-_la_1_ere._lent_et_douloureux.ogg"
ffmpeg -y -i satie.ogg -ar 8000 -ac 1 -c:a pcm_s16le assets/satie-gymnopedie-1.wav

curl -sSL -o joplin.ogg "https://upload.wikimedia.org/wikipedia/commons/1/1b/The_Entertainer_-_Scott_Joplin.ogg"
ffmpeg -y -i joplin.ogg -ar 8000 -ac 1 -c:a pcm_s16le assets/joplin-the-entertainer.wav
```

## Sans fichier

`holdMusic.file` vide : le module synthétise sa propre boucle, sans dépendance
ni licence.
