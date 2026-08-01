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
