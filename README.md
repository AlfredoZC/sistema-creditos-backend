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