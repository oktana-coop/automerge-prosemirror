MAKE_DIR := $(shell dirname $(realpath $(lastword $(MAKEFILE_LIST))))

.DEFAULT_GOAL := play

install:
	npm install
.PHONY: install

play: install
	npm run playground
.PHONY: play

compile:
	npx tsc --noEmit
.PHONY: compile

clean:
	rm -rf dist/
.PHONY: clean

deep-clean: clean
	rm -rf ./node_modules
	rm -rf ./*lock*
.PHONY: depp-clean

build: deep-clean install
	npm run build
.PHONY: build

pre-release: build checks
	npm publish --tag next
.PHONY: pre-release

release: build checks
	npm publish
.PHONY: release

format: 
	npm run lint --fix
.PHONY: format

lint: 
	npm run lint
.PHONY: lint

test:
	npm run mocha
.PHONY: test

checks: test
	@echo "✨ All checks are successful"
.PHONY: checks