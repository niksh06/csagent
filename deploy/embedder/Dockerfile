# Aleph query embedder — sentence-transformers behind a tiny FastAPI.
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

# Model weights are BAKED INTO THE IMAGE (I-172).
#
# They used to come from a read-only bind mount of the host HF cache with
# HF_HUB_OFFLINE=1 on top. That combination cannot self-heal: an empty host cache
# means the service both fails to start and is forbidden from downloading. On
# 2026-07-26 an OrbStack restart surfaced exactly that — the host cache had been
# cleared (this machine runs low on disk and gets cleaned periodically), the model
# had survived only in the running container's memory, and semantic memory search
# was down until the cache was rebuilt by hand.
#
# Baking costs ~1.1 GB of image and makes host-side cache cleanup irrelevant.
# Changing EMBED_MODEL now needs a rebuild — that is the trade, and it is the right
# one for a model that has not changed since this service was created.
ARG EMBED_MODEL=sentence-transformers/paraphrase-multilingual-mpnet-base-v2
ENV HF_HOME=/opt/hf
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${EMBED_MODEL}')" \
 && python -c "import pathlib,sys; n=sum(1 for f in pathlib.Path('/opt/hf').rglob('*') if f.is_file()); print(f'baked {n} files'); sys.exit(0 if n else 1)"

# Offline ONLY after the weights are in the image — the step above needs the network.
ENV EMBED_MODEL=${EMBED_MODEL} \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
