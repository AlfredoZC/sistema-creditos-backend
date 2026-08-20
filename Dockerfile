# Imagen de la API para uso local.
#
# Se instalan TODAS las dependencias, no solo las de produccion: las
# migraciones corren con typeorm sobre el data-source en TypeScript
# (`typeorm-ts-node-commonjs`), asi que ts-node tiene que existir en el
# contenedor. Para un uso local el tamano extra no importa; a cambio, el mismo
# comando de siempre aplica el esquema al arrancar.
FROM node:20-bookworm-slim

WORKDIR /app

# bcrypt trae binarios precompilados para glibc; por eso la imagen es
# bookworm-slim y no alpine.
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000

# Migraciones primero: la base recien creada por el compose no tiene esquema,
# y arrancar la API contra una base vacia falla de una forma dificil de leer.
CMD ["sh", "-c", "npm run migration:run && node dist/main"]
