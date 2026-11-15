"""Project entry point for the Skill's offline timeline exporter."""

import importlib.util
from pathlib import Path
import sys

_script = Path(__file__).resolve().parent / 'skills/edge-learning-review/scripts/generate_timeline.py'
_spec = importlib.util.spec_from_file_location('edge_timeline_exporter', _script)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
prepare, build, main = _module.prepare, _module.build, _module.main

if __name__ == '__main__':
    sys.exit(main())
