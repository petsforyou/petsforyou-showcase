#!/usr/bin/env python3
"""
Monta las diapositivas de un carrusel de producto a partir de un JSON.

Uso:
    python scripts/carrusel.py lista/comederos.json salida

Cada diapositiva sale a 1080x1350 con la foto real de producto,
titular arriba y texto abajo, sobre un fondo comun.

Cada diapositiva trae "imagen" (URL directa), "query" (texto a buscar
en Pexels; se usa la primera foto vertical del resultado) o "prompt"
(se genera la imagen con la API de imagenes de OpenAI, en vertical).
Si trae varias, se usa por orden de prioridad: imagen, query, prompt.
Buscar por query requiere PEXELS_API_KEY; generar por prompt requiere
OPENAI_API_KEY.
"""

import base64
import io
import json
import os
import sys
import textwrap

import requests
from PIL import Image, ImageDraw, ImageFont

ANCHO, ALTO = 1080, 1350
MARGEN = 80

FUENTE_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FUENTE_NORMAL = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

PEXELS_API_KEY = os.environ.get("PEXELS_API_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")


def hex_a_rgb(valor):
    valor = valor.lstrip("#")
    return tuple(int(valor[i:i + 2], 16) for i in (0, 2, 4))


class ErrorDescarga(RuntimeError):
    """La foto de producto no se pudo descargar: no tiene sentido montar la diapositiva sin ella."""


def buscar_foto_pexels(query):
    """Busca 'query' en Pexels y devuelve la URL de la primera foto vertical."""
    if not PEXELS_API_KEY:
        raise ErrorDescarga(
            "falta la variable de entorno PEXELS_API_KEY para buscar en Pexels"
        )
    try:
        respuesta = requests.get(
            "https://api.pexels.com/v1/search",
            headers={"Authorization": PEXELS_API_KEY},
            params={"query": query, "orientation": "portrait", "per_page": 1},
            timeout=30,
        )
        respuesta.raise_for_status()
        fotos = respuesta.json().get("photos", [])
    except (requests.RequestException, OSError) as exc:
        raise ErrorDescarga(f'fallo al buscar "{query}" en Pexels: {exc}') from exc

    if not fotos:
        raise ErrorDescarga(f'Pexels no ha devuelto resultados para "{query}"')

    foto = fotos[0]
    url = foto["src"]["large2x"]
    autor = foto.get("photographer", "desconocido")
    print(f'  Pexels "{query}" -> {url} (foto de {autor})')
    return url


def descargar(url):
    try:
        respuesta = requests.get(url, timeout=60)
        respuesta.raise_for_status()
        return Image.open(io.BytesIO(respuesta.content)).convert("RGB")
    except (requests.RequestException, OSError) as exc:
        raise ErrorDescarga(f"no se pudo descargar la imagen {url}: {exc}") from exc


def generar_foto_openai(prompt):
    """Genera una imagen vertical con la API de imagenes de OpenAI a partir de 'prompt'."""
    if not OPENAI_API_KEY:
        raise ErrorDescarga(
            "falta la variable de entorno OPENAI_API_KEY para generar la imagen"
        )
    try:
        respuesta = requests.post(
            "https://api.openai.com/v1/images/generations",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-image-2",
                "prompt": prompt,
                "size": "1024x1536",
                "n": 1,
            },
            timeout=120,
        )
        respuesta.raise_for_status()
        datos = respuesta.json().get("data", [])
    except (requests.RequestException, OSError) as exc:
        raise ErrorDescarga(
            f'fallo al generar la imagen para "{prompt}": {exc}'
        ) from exc

    if not datos or not datos[0].get("b64_json"):
        raise ErrorDescarga(f'OpenAI no ha devuelto ninguna imagen para "{prompt}"')

    print(f'  OpenAI prompt "{prompt}" -> imagen generada')
    imagen_bytes = base64.b64decode(datos[0]["b64_json"])
    return Image.open(io.BytesIO(imagen_bytes)).convert("RGB")


def obtener_foto(diapositiva):
    """Consigue la foto de producto: imagen > query > prompt, en ese orden."""
    imagen = diapositiva.get("imagen")
    if imagen:
        print(f"  imagen directa: {imagen}")
        return descargar(imagen)

    query = diapositiva.get("query")
    if query:
        return descargar(buscar_foto_pexels(query))

    prompt = diapositiva.get("prompt")
    if prompt:
        return generar_foto_openai(prompt)

    raise ErrorDescarga("la diapositiva no trae imagen, query ni prompt")


def recortar_cuadrado(imagen, lado):
    """Recorta al centro y escala a un cuadrado de 'lado' pixeles."""
    ancho, alto = imagen.size
    corte = min(ancho, alto)
    izq = (ancho - corte) // 2
    arr = (alto - corte) // 2
    imagen = imagen.crop((izq, arr, izq + corte, arr + corte))
    return imagen.resize((lado, lado), Image.LANCZOS)


def esquinas_redondeadas(imagen, radio):
    mascara = Image.new("L", imagen.size, 0)
    ImageDraw.Draw(mascara).rounded_rectangle(
        [(0, 0), imagen.size], radius=radio, fill=255
    )
    salida = Image.new("RGBA", imagen.size, (0, 0, 0, 0))
    salida.paste(imagen, (0, 0), mascara)
    return salida


def partir_lineas(draw, texto, fuente, ancho_max):
    """Parte 'texto' en las lineas que hacen falta para caber en ancho_max."""
    if not texto:
        return []
    lineas = []
    for parrafo in texto.split("\n"):
        if not parrafo.strip():
            lineas.append("")
            continue
        # Ajuste por ancho real de pixel, no por numero de caracteres
        palabras = parrafo.split()
        actual = ""
        for palabra in palabras:
            prueba = (actual + " " + palabra).strip()
            if draw.textlength(prueba, font=fuente) <= ancho_max:
                actual = prueba
            else:
                if actual:
                    lineas.append(actual)
                actual = palabra
        if actual:
            lineas.append(actual)
    return lineas


def alto_lineas(lineas, fuente, interlineado):
    """Alto total que ocupan 'lineas' ya partidas, sin dibujarlas."""
    return len(lineas) * int(fuente.size * interlineado)


def escribir_lineas(draw, lineas, y, fuente, color, interlineado=1.25,
                     centrado=True):
    """Dibuja 'lineas' ya partidas empezando en y. Devuelve la y final."""
    alto_linea = int(fuente.size * interlineado)
    for linea in lineas:
        if linea:
            if centrado:
                x = (ANCHO - draw.textlength(linea, font=fuente)) / 2
            else:
                x = MARGEN
            draw.text((x, y), linea, font=fuente, fill=color)
        y += alto_linea
    return y


def escribir(draw, texto, y, fuente, color, ancho_max, interlineado=1.25,
             centrado=True):
    """Escribe texto con salto de linea automatico. Devuelve la y final."""
    lineas = partir_lineas(draw, texto, fuente, ancho_max)
    return escribir_lineas(draw, lineas, y, fuente, color, interlineado, centrado)


def montar(diapositiva, config, indice, carpeta_salida):
    fondo = hex_a_rgb(config.get("fondo", "#F5EFE6"))
    color_titular = hex_a_rgb(config.get("color_titular", "#2E2A26"))
    color_texto = hex_a_rgb(config.get("color_texto", "#5A524A"))
    color_acento = hex_a_rgb(config.get("color_acento", "#C4784A"))

    lienzo = Image.new("RGB", (ANCHO, ALTO), fondo)
    draw = ImageDraw.Draw(lienzo)

    portada = indice == 0
    f_titular = ImageFont.truetype(FUENTE_BOLD, 76 if portada else 58)
    f_texto = ImageFont.truetype(FUENTE_NORMAL, 38)
    f_para = ImageFont.truetype(FUENTE_BOLD, 32)

    ancho_max = ANCHO - (MARGEN * 2)

    # Titular
    y = 110
    y = escribir(draw, diapositiva["titular"], y, f_titular,
                 color_titular, ancho_max, interlineado=1.15)

    # Linea de acento bajo el titular
    y += 28
    draw.rounded_rectangle(
        [(ANCHO / 2 - 60, y), (ANCHO / 2 + 60, y + 8)],
        radius=4, fill=color_acento,
    )
    y += 60
    y_foto = y

    # Medimos cuanto va a ocupar el texto de debajo (partido en lineas, sin
    # dibujarlo todavia) para saber cuanto sitio le sobra a la foto.
    GAP_FOTO_TEXTO = 55
    MARGEN_INFERIOR = 70

    texto_lineas = partir_lineas(draw, diapositiva.get("texto", ""), f_texto,
                                  ancho_max)
    alto_texto = alto_lineas(texto_lineas, f_texto, 1.35)

    para = diapositiva.get("para", "")
    para_lineas = partir_lineas(draw, para, f_para, ancho_max) if para else []
    alto_para = 22 + alto_lineas(para_lineas, f_para, 1.3) if para_lineas else 0

    alto_bloque_texto = GAP_FOTO_TEXTO + alto_texto + alto_para + MARGEN_INFERIOR

    # Foto de producto: ocupa el espacio que sobra hasta la zona de texto,
    # entre la mitad y dos tercios de la altura del lienzo.
    lado = ALTO - y_foto - alto_bloque_texto
    lado = max(ALTO // 2, min(int(ALTO * 2 / 3), lado))

    foto = esquinas_redondeadas(
        recortar_cuadrado(obtener_foto(diapositiva), lado), 40
    )
    lienzo.paste(foto, (int((ANCHO - lado) / 2), int(y_foto)), foto)
    y = y_foto + lado + GAP_FOTO_TEXTO

    # Texto
    y = escribir_lineas(draw, texto_lineas, y, f_texto, color_texto,
                         interlineado=1.35)

    # Linea de "para quien"
    if para_lineas:
        y += 22
        escribir_lineas(draw, para_lineas, y, f_para, color_acento,
                         interlineado=1.3)

    nombre = f"{config['nombre']}_{indice + 1:02d}.png"
    ruta = os.path.join(carpeta_salida, nombre)
    lienzo.save(ruta, "PNG")
    print(f"  {nombre}")


def main():
    if len(sys.argv) < 3:
        print("Uso: carrusel.py <fichero.json> <carpeta_salida>")
        sys.exit(1)

    ruta_json, carpeta_salida = sys.argv[1], sys.argv[2]
    os.makedirs(carpeta_salida, exist_ok=True)

    with open(ruta_json, encoding="utf-8") as fichero:
        config = json.load(fichero)

    print(f"Montando {len(config['diapositivas'])} diapositivas...")
    for indice, diapositiva in enumerate(config["diapositivas"]):
        try:
            montar(diapositiva, config, indice, carpeta_salida)
        except ErrorDescarga as exc:
            print(f"Error en la diapositiva {indice + 1}: {exc}", file=sys.stderr)
            sys.exit(1)
    print("Listo.")


if __name__ == "__main__":
    main()
