# Spec 1 work tree

Source spec: `/home/dami/wj/docs/superpowers/specs/2026-05-09-claude-notebook-real-impl-design.md`
Source plan: `/home/dami/wj/docs/superpowers/plans/2026-05-09-claude-notebook-real-impl.md`

- Port: **8889** (운영본은 8888, 절대 건드리지 않음)
- Branch: `spec1-real-impl`
- Boot:
  ```bash
  cd /home/dami/claude-notebook-v2 && source .venv/bin/activate
  PYTHONPATH=. nohup jupyter notebook --no-browser --ip=0.0.0.0 --port=8889 --notebook-dir=/home/dami/wj > /tmp/cn-v2.log 2>&1 &
  disown
  ```

운영 교체는 Spec §5.7.4 의 S1~S8 parity 시나리오 모두 PASS 후, 사용자 명시 승인 시점에만.
