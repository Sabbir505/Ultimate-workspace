# Scoop manifest for Relay

Ship `relay.json` from a bucket repo (e.g. `Sabbir505/scoop-bucket`):

    scoop bucket add relay https://github.com/Sabbir505/scoop-bucket
    scoop install relay

Update the `url` version and `hash` per release (the hash is the SHA-256 of
the `Relay_<version>_x64-setup.exe` release asset).
