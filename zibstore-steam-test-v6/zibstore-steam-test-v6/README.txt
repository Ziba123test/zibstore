ЗибСтор — тест Steam цен v4

Проверяет: Netlify Function → Steam App/Package → ЦБ РФ → RUB.

Тесты:
1) DOOM Premium: package 1221725, реальная цена Digiseller 1 986 ₽.
2) Assassin's Creed Black Flag Resynced: AppID 3751950, реальная цена Digiseller 3 163 ₽.
3) Граничный сценарий: тот же Steam AppID, но условная цена ЗибСтора 6 000 ₽ — проверяем, что Steam дешевле и формула не показывает отрицательную экономию.
4) Намеренно несуществующий package ID — проверяем graceful failure при отсутствии цены.
