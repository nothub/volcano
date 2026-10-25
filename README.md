# 🌋 Volcano App

Web Bluetooth remote control for the Storz & Bickel Volcano Hybrid.

## Run

Web BLE needs Chrome or Chromium and a secure context (https or localhost):

```sh
python3 -m http.server 8000 --bind 127.0.0.1
# open http://localhost:8000
```

## Test

```sh
deno test
```
