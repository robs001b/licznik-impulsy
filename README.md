# Licznik impulsów - moc z diod kWh / kvarh przez aparat telefonu

Statyczna aplikacja PWA (bez serwera). Tylna kamera obserwuje diody impulsowe licznika (np. Sanxing S34U28-PL-T10, 1000 imp/kWh i 1000 imp/kvarh), a aplikacja liczy moc z czasu między impulsami:

P [kW] = 3600 / (stała [imp/kWh] · T [s]), Q [kvar] analogicznie, cos φ = P / √(P² + Q²).

- Dwa małe obszary pomiarowe (ROI) zaznaczane dotykiem, okno 2× ROI do śledzenia przesunięcia.
- Detekcja: jasność ROI względem adaptacyjnego tła (dolna obwiednia), próg z histerezą, zbocze narastające interpolowane między klatkami, potwierdzenie na zboczu opadającym, debounce, odrzucanie długiego świecenia, tłumienie przesłuchu między diodami.
- Próbkowanie przez `requestVideoFrameCallback` (znacznik `captureTime`), zapas: `requestAnimationFrame`.
- Zoom, kompensacja / czas ekspozycji, latarka - jeśli aparat je udostępnia. Wake Lock.
- Wykres mocy, eksport CSV (separator `;`, przecinek dziesiętny), tryb symulacji.

Uwaga: dioda kvarh może sumować energię bierną indukcyjną i pojemnościową - Q nie mówi o charakterze mocy biernej.

## Testy
```
node tests/detector-test.js            # logika detekcji na sztucznych klatkach
node tests/film-test.js film.mp4       # offline na filmie (ffmpeg); FPS=30 symuluje wolniejszą kamerę
cd tests && npm i && node ui-test.mjs http://localhost:8765/ ../zrzuty [film.y4m]
```
