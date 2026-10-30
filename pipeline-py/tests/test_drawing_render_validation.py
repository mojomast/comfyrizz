import json

from comfyrizz_pipeline import schema as S


def test_drawing_replaces_layout_and_media_but_remains_validated():
    base = json.loads((S.repo_root() / 'packages/schema/fixtures/valid/minimal.json').read_text())
    drawing = {'background': '#ffffff', 'elements': [{'type': 'path', 'color': '#000000', 'width': 4, 'points': [[0, 0], [100, 100]], 'start': 0, 'end': 5}]}
    for layout in ('hero', 'chart', 'code', 'split'):
        base['scenes'] = [{'id': 's1', 'layout': layout, 'preferredFrames': 90, 'media_only': True, 'drawing': drawing}]
        result = S.validate_package(base)
        assert result['valid'], result['errors']
    base['scenes'][0] = {'id': 's1', 'layout': 'hero', 'preferredFrames': 90, 'media_only': True}
    codes = {e['code'] for e in S.validate_package(base)['errors']}
    assert {'SEM_COPY_REQUIRED', 'SEM_MEDIA_ONLY_NO_MEDIA'} <= codes
    base['scenes'][0]['drawing'] = {'background': '#ffffff', 'elements': []}
    assert not S.validate_package(base)['valid']
