"""Package the self-contained plugin without dependencies, credentials or task data."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
output = root / 'dsh-commander.zip'
excluded = {'node_modules', '.git', 'test-output', '__pycache__', '.playwright-cli', 'output'}
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        relative = file.relative_to(root)
        if not file.is_file() or any(p in excluded for p in relative.parts) or file.suffix == '.zip':
            continue
        archive.write(file, str(Path(root.name) / relative))
print(output)
print(f'{output.stat().st_size:,} bytes')
