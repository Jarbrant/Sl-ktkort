# Släktträdet

Detta projekt är ett **lärprojekt** för att förstå hur man bygger
ett system steg för steg – från idé till struktur, utan att blanda roller
eller bygga för stort för tidigt.

Fokus ligger på **modell, ordning och begriplighet** – inte på färdig produkt.

---

## 🎯 Syfte

Att bygga ett enkelt släktträd genom att arbeta i rätt ordning:

1. Släktkort (en person)
2. Relationer (förälder → barn)
3. Skaparläge (lägga in data)
4. Visualisering (träd)

Projektet används för att lära sig:
- hur arkitektur, UX och kod hålls isär
- hur GitHub kan användas som struktur, inte stress
- hur små system kan byggas korrekt från början

---

## 🧱 Vad som är byggt / låst

### Släktkort (LÅST)
Ett släktkort representerar **en person i släktsammanhang**.

Fält:
- Förnamn
- Efternamn
- Kön (Man / Kvinna / Okänt)
- Födelseår
- Dödsår
- Plats (fri text)
- Anteckning (fri text)

Släktkortet innehåller **inga relationer**.

---

### Relationer (LÅST)
Relationer är **separata objekt**, inte en del av släktkortet.

Endast en relationstyp används i detta steg:

- **Förälder → barn**

Regler:
- En person kan ha 0–2 föräldrar
- En person kan ha flera barn
- Inga cirklar är tillåtna
- Relationer lagras separat från släktkort

---

## ✏️ Skaparläge (pågående)
Projektet innehåller ett **mycket enkelt skaparläge** för att:

- skapa släktkort
- skapa relationer mellan släktkort

Detta är **inte** en adminpanel.
Det finns:
- ingen inloggning
- inga roller
- ingen behörighet

Syftet är enbart att kunna mata in data för att testa modellen.

---

## 📁 Projektstruktur

