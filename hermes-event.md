# Temuan: Hook & Event di Hermes Agent

Berdasarkan dokumentasi resmi Hermes Agent (Nous Research), terdapat **4 sistem hook utama** yang berjalan di titik-titik siklus hidup agen, yaitu:
1. **Gateway hooks:** Didefinisikan menggunakan manifest `HOOK.yaml` dan `handler.py`.
2. **Plugin hooks:** Didaftarkan menggunakan `ctx.register_hook()` di dalam kode plugin Python.
3. **Shell hooks:** Didefinisikan di dalam profil `config.yaml` yang merujuk pada skrip bash/shell (seperti `pre_tool_call`).
4. **Outbound webhooks:** Didefinisikan di `hooks.outbound` di `config.yaml` untuk mengirim payload HTTP ke endpoint eksternal.

Berikut adalah daftar **Event Lifecycle (Kejadian)** yang bisa ditangkap oleh Hook tersebut:

## A. Gateway Hook Events (di `HOOK.yaml`):
Event ini spesifik berjalan ketika agen berjalan dalam mode Gateway (seperti bot Telegram, Discord, Slack):
1. `gateway:startup` - Proses gateway pertama kali dinyalakan.
2. `session:start` - Sesi percakapan baru dimulai.
3. `session:end` - Sesi selesai atau terkena *timeout*.
4. `session:reset` - Pengguna mereset sesi (misalnya dengan command `/new`).
5. `agent:start` - Agen mulai memproses sebuah pesan masuk.
6. `agent:step` - Agen menyelesaikan satu iterasi penggunaan *tool* (tool-calling).
7. `agent:end` - Agen selesai memproses dan mengembalikan respons akhir.
8. `command:*` - Dijalankan ketika ada eksekusi slash command (misal `/help`, dll).

## B. Plugin Hook Events (di `ctx.register_hook`):
Event ini berjalan di antarmuka CLI maupun Gateway.
1. `pre_tool_call` - Dijalankan sebelum agen memanggil sebuah *tool*. (Bisa memblokir operasi).
2. `post_tool_call` - Dijalankan setelah *tool* selesai mengembalikan hasil.
3. `pre_llm_call` - Dijalankan sebelum agen mengirim prompt ke LLM.
4. `post_llm_call` - Dijalankan setelah mendapat balasan/stream dari LLM.
5. `on_session_start` - Saat inisialisasi awal.
6. `on_session_end` - Saat *cleanup* di akhir.

## C. Kanban Board Events (di `ctx.register_hook`):
Digunakan untuk manajemen sistem tugas lintas-agen (multi-profile collaboration board):
1. `kanban_task_claimed` - Tugas diambil oleh proses *worker*.
2. `kanban_task_completed` - Tugas diselesaikan oleh proses *worker*.
3. `kanban_task_blocked` - Tugas terhalang/diblokir oleh ketergantungan lain.