# Licznik impulsów - moc z diod kWh / kvarh przez aparat telefonu

Statyczna aplikacja PWA (bez serwera). Tylna kamera obserwuje diody impulsowe licznika (np. Sanxing S34U28-PL-T10, 1000 imp/kWh i 1000 imp/kvarh), a aplikacja liczy moc z czasu między impulsami:

P [kW] = 3600 / (stała [imp/kWh] · T [s]), Q [kvar] analogicznie, cos φ = P / √(P² + Q²).

- "Znajdź diody": 5 s analizy kadru - mapa zmian tylko czerwonych pikseli, małe zwarte plamy błyskające 20-350 ms, odrzucenie szybko migającej diody modułu, odblasków, krawędzi i poświaty; lewa = kWh, następna w rzędzie = kvarh. Ręczne zaznaczanie dotykiem zostaje.
- Sygnał "czerwona dioda": czerwień R ponad G i B; białe/prześwietlone piksele tylko w czerwonej poświacie (rdzeń świecącej diody); pierścień wokół ROI (kształt) i globalne tło kadru (cień, lampa, migotanie 50/100 Hz) nie dają impulsu.
- Ostrość: focusMode continuous, dotknij-aby-ustawić (pointsOfInterest), blokada (manual z bieżącą odległością lub single-shot), status.
- Dwa małe obszary pomiarowe (ROI), okno 2× ROI do śledzenia przesunięcia.
- Detekcja: jasność ROI względem adaptacyjnego tła (dolna obwiednia), próg z histerezą, zbocze narastające interpolowane między klatkami, potwierdzenie na zboczu opadającym, debounce, odrzucanie długiego świecenia, tłumienie przesłuchu między diodami.
- Próbkowanie przez `requestVideoFrameCallback` (znacznik `captureTime`), zapas: `requestAnimationFrame`.
- Zoom, kompensacja / czas ekspozycji, latarka - jeśli aparat je udostępnia. Wake Lock.
- Wykres mocy, eksport CSV (separator `;`, przecinek dziesiętny), tryb symulacji.

Uwaga: dioda kvarh może sumować energię bierną indukcyjną i pojemnościową - Q nie mówi o charakterze mocy biernej.

## Testy
```
node tests/detector-test.js            # logika detekcji na sztucznych przebiegach
node tests/scene-test.js               # sztuczne klatki obrazu: odblask, migotanie 100 Hz, cień, moduł, refleks
node tests/film-test.js film.mp4       # offline na filmie (ffmpeg); FPS=30 symuluje wolniejszą kamerę
cd tests && npm i && node ui-test.mjs http://localhost:8765/ ../zrzuty [film.y4m]
```
