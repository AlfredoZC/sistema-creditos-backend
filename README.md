<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="200" alt="Nest Logo" /></a>
</p>

# PROYECTO API

1. Clonar el proyecto
2. Instalar los modulos de node

```
npm install
```

3. Configurar las variables de entorno tomando la plantilla `.env.template` y clonar a un archivo `.env`
4. Cambiar las variables de entorno
5. Levantar la base de datos

```
docker-compose up -d
```

> La base usa `postgres:18-alpine` y guarda los datos en el volumen externo `plataforma-creditos_pgdata`. En una máquina nueva, crearlo antes: `docker volume create plataforma-creditos_pgdata`

6. Levantar la aplicacion en modo desarrollo

```
npm run start:dev
```

7. Ejecutar SEED (Cargar datos de prueba)

```
http://localhost:3000/api/seed
```

8. Ver documentacion RESTFUL API en el NAVEGADOR (RECOMENDADO PARA VER LOS ENDPOINTS)
```
http://localhost:3000/api
```

---

## Migraciones de base de datos

El esquema de la base de datos se gestiona **exclusivamente con migraciones** (`synchronize` está deshabilitado). Cada cambio de esquema se versiona como una migración en `src/database/migrations/` y se aplica explícitamente. Esto garantiza que el esquema en la nube sea reproducible y con posibilidad de rollback.

### Flujo de trabajo

1. **Crear una migración a partir de los cambios en las entidades**

```bash
npm run migration:generate -- src/database/migrations/NombreDeLaMigracion
```

2. **Revisar la migración generada** antes de aplicarla (el archivo queda en `src/database/migrations/`).

3. **Aplicar las migraciones pendientes**

```bash
npm run migration:run
```

4. **Ver el estado de las migraciones**

```bash
npm run migration:show
```

5. **Revertir la última migración** (solo para corrección en desarrollo)

```bash
npm run migration:revert
```

6. **Crear una migración vacía** para escribir SQL a mano

```bash
npm run migration:create -- src/database/migrations/NombreDeLaMigracion
```

### En la nube

Como paso previo al despliegue, ejecutar las migraciones contra la base de datos de producción:

```bash
npm run build
npm run migration:run
```

Las migraciones se aplican manualmente y nunca automáticamente al iniciar la aplicación (`migrationsRun: false`).

> **Nota**: si la base de datos local ya fue creada con `synchronize: true`, regenerar la base de datos desde cero (o borrar su esquema) y aplicar `migration:run` para dejar la línea de base (`Init`) registrada.

---

## Ejecucion local completa (API + base + frontend)

```bash
docker volume create plataforma-creditos_pgdata   # solo la primera vez
docker-compose up -d                              # Postgres 18 en localhost:5439
cp .env.template .env                             # revisar credenciales
npm install
npm run migration:run                             # aplica las 6 migraciones
npm run start:dev                                 # API en http://localhost:3000/api
```

Cargar datos de prueba: abrir `http://localhost:3000/api/seed`.
Documentacion interactiva de todos los endpoints: `http://localhost:3000/api`.

El frontend (`sistema-creditos`) corre con `npm run dev` en
`http://localhost:5173`, que es uno de los origenes permitidos por defecto en
CORS. Si se sirve desde otro puerto u host, hay que declararlo en
`CORS_ORIGINS`.

## Reportes de cobranza

| Endpoint | Rol | Devuelve |
|---|---|---|
| `GET /api/reports/summary?from=&to=` | office, admin | Recaudado del rango, pendiente de confirmacion, cartera vigente, mora, vencimientos a 7 dias y planes por estado. Sin parametros, el rango es el mes en curso |
| `GET /api/reports/overdue-installments?limit=&offset=` | office, admin | Cola de cobranza: cuotas vencidas sin saldar con paciente, telefono, saldo y dias de atraso, de la mas atrasada a la menos |

Los montos viajan como string decimal con dos decimales, igual que en el resto
de la API.

## Recordatorios automaticos

Un job diario (9 AM) manda por WhatsApp dos tipos de aviso:

- `due_soon`: la cuota vence en 3 dias.
- `overdue`: la cuota ya vencio.

Se puede disparar a mano con `POST /api/reminders/run` (solo admin), que
devuelve `{ dueSoon, overdue, skipped, failed }`.

**Es idempotente por base de datos**: antes de despachar se inserta una fila en
`installment_reminders`, cuya UNIQUE `(installment_id, kind)` impide que una
segunda corrida -o dos instancias a la vez- manden el mismo aviso dos veces.
Para forzar un reenvio hay que borrar esa fila.

Las plantillas se resuelven por nombre y son configurables
(`REMINDER_TEMPLATE_DUE_SOON`, `REMINDER_TEMPLATE_OVERDUE`). Ambas deben existir
en `message_templates` con `status='approved'` e `is_active=true`, y declarar
exactamente tres placeholders: `{{1}}` nombre, `{{2}}` numero de cuota y `{{3}}`
fecha de vencimiento. El seed crea `payment_reminder` y `payment_overdue`.

Cada corrida despacha como maximo `REMINDER_MAX_PER_RUN` avisos por tipo (200
por defecto): con mora acumulada, la primera corrida no intenta mandar miles de
mensajes de una sentada, y el atraso se drena en las corridas siguientes.

Con `WHATSAPP_PROVIDER=mock` (default) no sale ningun mensaje real.

## Portales de paciente y doctor

No hay un prefijo `/portal`: los mismos endpoints recortan el resultado segun
el rol del token.

| Rol | Ve |
|---|---|
| `patient` | Sus cirugias (`GET /api/surgeries`, `GET /api/surgeries/:id`), sus planes y cuotas (`GET /api/payment-plans...`), su historial de pagos y puede registrar un pago, que queda `pending_confirmation` |
| `doctor` | Solo las cirugias donde esta asignado, con cualquier rol de asignacion. NO ve planes, cuotas ni deuda de los pacientes |
| `office`, `admin` | Todo, incluidas las escrituras |

El paciente se resuelve por `patients.user_id` a partir del token; nunca por un
id que venga en la request.
